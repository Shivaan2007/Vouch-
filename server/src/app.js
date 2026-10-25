import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import * as cfg from './config.js';
import { EV } from './events.js';
import { openDb } from './db.js';
import { verifySig, isP256Spki, newId, sha256hex, normalizeText } from './sig.js';
import { decide, tierFor } from './decision.js';
import { analyzeSafe } from './analyze.js';
import { authString, answerString, confirmString, METHODS } from '../../web/js/lib/canonical.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HEX32 = /^[0-9a-f]{32}$/;
const IMAGE_URL = /^data:image\/(jpeg|png);base64,/;
const PRE_AUTH = new Set([EV.USER_REGISTER, EV.AUTH_LOGIN]);

class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ProtocolError(code); };

const DEMO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Vouch demo</title>
<style>body{font:18px system-ui;margin:16px;max-width:420px}input,button{font:inherit;padding:14px;width:100%;margin:6px 0;box-sizing:border-box}
button{border:0;border-radius:10px;background:#111;color:#fff}button.hard{background:#a00}pre{white-space:pre-wrap;background:#eee;padding:10px;border-radius:8px}</style></head>
<body><h2>Vouch demo</h2><input id="k" type="password" placeholder="demo key" autocomplete="off">
<button id="status">Check status</button><button id="reset">Reset demo (keep friends)</button>
<button id="hard" class="hard">Wipe everything (re-pair phones)</button><pre id="out">ready</pre>
<script>
const out=document.getElementById('out'),key=()=>document.getElementById('k').value;
async function go(path,method){try{const r=await fetch(path,{method,headers:{'x-demo-key':key()}});out.textContent=JSON.stringify(await r.json(),null,1)}catch(e){out.textContent=String(e)}}
status.onclick=()=>go('/demo/status','GET');reset.onclick=()=>go('/demo/reset','POST');
hard.onclick=()=>{if(confirm('Delete all users and pairs?'))go('/demo/reset?hard=1','POST')};
</script></body></html>`;

export function createVouchServer({
  dbPath = ':memory:',
  webDir = path.join(here, '..', '..', 'web'),
  timeoutMs = cfg.TIMEOUT_MS,
  sweepMs = 1000,
  analyze,
  demoKey = process.env.DEMO_KEY,
  registerPerMin = cfg.REGISTER_PER_MIN,
  log = (...a) => console.log(...a),
} = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    next();
  });
  // Background work (follow-up emits, the timeout sweep) runs outside a handler's try/catch. An error there must never
  // reach the process: on the free plan a crash restarts the server and erases every pairing.
  const safe = (fn) => { try { return fn(); } catch (e) { log(`background error: ${e.message}`); return undefined; } };
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- demo helpers (disabled unless DEMO_KEY is set) ----
  const demoGuard = (req, res, next) => {
    if (!demoKey) return res.status(404).end();
    const given = Buffer.from(String(req.get('x-demo-key') || ''));
    const want = Buffer.from(String(demoKey));
    return given.length === want.length && crypto.timingSafeEqual(given, want)
      ? next() : res.status(403).json({ ok: false, error: 'bad_key' });
  };
  app.get('/demo', (_req, res) => (demoKey ? res.type('html').send(DEMO_PAGE) : res.status(404).end()));
  app.post('/demo/reset', demoGuard, (req, res) => res.json({ ok: true, ...resetDemo(req.query.hard === '1') }));
  app.get('/demo/status', demoGuard, (_req, res) => res.json({ ok: true, ...demoStatus() }));
  app.use(express.static(webDir));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 6 * 1024 * 1024 });

  const rate = new Map();      // checker id -> request timestamps
  const pairRate = new Map();  // user id -> pair:accept timestamps
  const offerRate = new Map(); // user id -> pair:offer timestamps
  const regRate = new Map();   // client address -> user:register timestamps
  const analyses = new Map();  // requestId -> Promise while AI analysis is running

  const q = {
    user: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    insUser: db.prepare('INSERT INTO users VALUES (?,?,?,?,?)'),
    insToken: db.prepare('INSERT INTO pair_tokens VALUES (?,?,?,0)'),
    token: db.prepare('SELECT * FROM pair_tokens WHERE token = ?'),
    useToken: db.prepare('UPDATE pair_tokens SET used = 1 WHERE token = ? AND used = 0'),
    pair: db.prepare('SELECT * FROM pairs WHERE user_a = ? AND user_b = ?'),
    insPair: db.prepare('INSERT INTO pairs VALUES (?,?,?)'),
    friends: db.prepare(`SELECT u.*, p.created_at AS paired_at FROM pairs p
      JOIN users u ON u.user_id = CASE WHEN p.user_a = @u THEN p.user_b ELSE p.user_a END
      WHERE p.user_a = @u OR p.user_b = @u ORDER BY p.created_at, u.user_id`),
    priorReq: db.prepare(`SELECT 1 FROM verify_requests WHERE
      (checker_id = @a AND claimed_id = @b) OR (checker_id = @b AND claimed_id = @a) LIMIT 1`),
    insReq: db.prepare(`INSERT INTO verify_requests
      (request_id, checker_id, claimed_id, amount_cents, method, channel, tier, tags, payment_risk, first_request, text_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    req: db.prepare('SELECT * FROM verify_requests WHERE request_id = ?'),
    setAnalysis: db.prepare('UPDATE verify_requests SET tags=?, payment_risk=?, explanation=?, source=? WHERE request_id=?'),
    setStatus: db.prepare('UPDATE verify_requests SET status = ? WHERE request_id = ?'),
    setWord: db.prepare('UPDATE verify_requests SET word_ok = 1 WHERE request_id = ?'),
    setSecond: db.prepare('UPDATE verify_requests SET second_user_id = ? WHERE request_id = ?'),
    insApproval: db.prepare('INSERT INTO approvals (request_id,user_id,role,answer,ts,nonce,sig,created_at) VALUES (?,?,?,?,?,?,?,?)'),
    approval: db.prepare('SELECT * FROM approvals WHERE request_id = ? AND role = ?'),
    insAlert: db.prepare('INSERT INTO alerts (claimed_id,request_id,impersonated_name,ts) VALUES (?,?,?,?)'),
    expired: db.prepare(`SELECT request_id FROM verify_requests WHERE status = 'open' AND created_at <= ?`),
    openFor: db.prepare(`SELECT * FROM verify_requests WHERE claimed_id = ? AND status = 'open' AND created_at > ?`),
    secondFor: db.prepare(`SELECT * FROM verify_requests WHERE second_user_id = ? AND status = 'answered'`),
    recentBy: db.prepare('SELECT request_id FROM verify_requests WHERE checker_id = ? AND created_at > ?'),
  };

  const orderedPair = (a, b) => (a < b ? [a, b] : [b, a]);
  const room = (userId) => `user:${userId}`;
  const emitTo = (userId, ev, payload) => io.to(room(userId)).emit(ev, payload);
  const isOnline = (userId) => (io.sockets.adapter.rooms.get(room(userId))?.size || 0) > 0;
  const pub = (u) => ({ id: u.user_id, name: u.name, signPub: u.sign_pub, exchPub: u.exch_pub });
  const isPaired = (a, b) => !!q.pair.get(...orderedPair(a, b));
  const throttle = (map, key, limit) => {
    const now = Date.now();
    const hits = (map.get(key) || []).filter((t) => now - t < 60000);
    if (hits.length >= limit) fail('RATE_LIMITED');
    hits.push(now);
    map.set(key, hits);
  };

  // Behind Render's proxy the real client is the first X-Forwarded-For entry.
  const clientAddress = (socket) => String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();

  function freshChallenge(socket) {
    socket.data.nonce = crypto.randomBytes(16).toString('hex');
    socket.emit(EV.AUTH_CHALLENGE, { nonce: socket.data.nonce });
  }
  function authed(socket, userId) {
    socket.data.userId = userId;
    socket.join(room(userId));
  }
  function signedChallenge(socket, signPub, sig) {
    const nonce = socket.data.nonce;
    if (!nonce || typeof sig !== 'string') fail('BAD_SIGNATURE');
    const ok = verifySig(signPub, authString(nonce), sig);
    if (!ok) fail('BAD_SIGNATURE');
    // A nonce is good for one successful login. Do NOT send another auth:challenge here: the phone answers every challenge
    // with a login, so that would loop. One challenge per connection, as PROTOCOL section 2 says.
    socket.data.nonce = null;
  }

  // ---- verdicts ----
  function buildUpdate(r) {
    const claimed = q.user.get(r.claimed_id);
    const a = q.approval.get(r.request_id, 'claimed');
    const s = q.approval.get(r.request_id, 'second');
    const tags = JSON.parse(r.tags);
    const timedOut = r.status === 'timed_out' && !a;
    const d = decide({
      answer: a ? a.answer : 'none', tags, paymentRisk: r.payment_risk, amountCents: r.amount_cents,
      wordOk: !!r.word_ok, secondConfirms: s?.answer === 'yes' ? 1 : 0, secondNo: s?.answer === 'no', timedOut,
    });
    const reasons = [...d.reasons];
    if (d.needs.second && a?.answer === 'yes' && !r.second_user_id && d.verdict === 'amber') {
      reasons.push('Add a third member to your circle');
    }
    return {
      requestId: r.request_id, checkerId: r.checker_id, claimedId: r.claimed_id,
      verdict: d.verdict, tier: d.tier, reasons, needs: d.needs,
      stages: {
        information: { claimedName: claimed.name, amountCents: r.amount_cents, method: r.method, channel: r.channel },
        understanding: { tags, paymentRisk: r.payment_risk, explanation: r.explanation, firstRequest: !!r.first_request },
        confidence: {
          answer: a ? a.answer : (timedOut ? 'timeout' : 'none'), wordOk: !!r.word_ok,
          // the second person only: the phone shows "Second person: received of needed" and hides it when needed is 0
          approvals: { needed: d.needs.second ? 1 : 0, received: s?.answer === 'yes' ? 1 : 0 },
          answerSig: a ? { answer: a.answer, ts: a.ts, nonce: a.nonce, sig: a.sig } : null,
        },
      },
    };
  }

  function pushUpdate(requestId) {
    const r = q.req.get(requestId);
    if (!r) return;
    const u = buildUpdate(r);
    emitTo(r.checker_id, EV.VERIFY_UPDATE, u);
    log(`update ${requestId.slice(0, 8)} ${u.verdict} tier${u.tier}`);
  }

  const promptFor = (r) => ({
    requestId: r.request_id, checker: { id: r.checker_id, name: q.user.get(r.checker_id).name },
    amountCents: r.amount_cents, method: r.method, channel: r.channel, tier: r.tier, ts: r.created_at,
  });
  const confirmPromptFor = (r) => ({
    requestId: r.request_id, claimedId: r.claimed_id, checkerName: q.user.get(r.checker_id).name,
    claimedName: q.user.get(r.claimed_id).name, amountCents: r.amount_cents, method: r.method,
  });

  // The claimed person's other friends (not the checker) can act as the second member.
  const secondCandidates = (r) => q.friends.all({ u: r.claimed_id }).filter((u) => u.user_id !== r.checker_id);

  function promptSecond(r) {
    const [pick] = secondCandidates(r);
    if (!pick) return;
    q.setSecond.run(pick.user_id, r.request_id);
    emitTo(pick.user_id, EV.VERIFY_CONFIRM_PROMPT, confirmPromptFor(r));
  }

  function alertFriends(r) {
    const claimed = q.user.get(r.claimed_id);
    const ts = Date.now();
    q.insAlert.run(claimed.user_id, r.request_id, claimed.name, ts);
    for (const f of q.friends.all({ u: claimed.user_id })) {
      emitTo(f.user_id, EV.CIRCLE_ALERT, { impersonatedName: claimed.name, claimedId: claimed.user_id, requestId: r.request_id, ts });
    }
  }

  // After a (re)login, resend anything still waiting on this user.
  function resendPending(userId) {
    const now = Date.now();
    for (const r of q.openFor.all(userId, now - timeoutMs)) emitTo(userId, EV.VERIFY_PROMPT, promptFor(r));
    for (const r of q.secondFor.all(userId)) {
      if (!q.approval.get(r.request_id, 'second')) emitTo(userId, EV.VERIFY_CONFIRM_PROMPT, confirmPromptFor(r));
    }
    for (const { request_id } of q.recentBy.all(userId, now - 10 * 60 * 1000)) {
      emitTo(userId, EV.VERIFY_UPDATE, buildUpdate(q.req.get(request_id)));
    }
  }

  function checkNonceTs(ts, nonce) {
    if (!Number.isInteger(ts) || Math.abs(Date.now() - ts) > cfg.MAX_TS_AGE_MS) fail('BAD_INPUT');
    if (typeof nonce !== 'string' || !HEX32.test(nonce)) fail('BAD_INPUT');
  }

  function storeApproval(r, userId, role, p) {
    try {
      q.insApproval.run(r.request_id, userId, role, p.answer, p.ts, p.nonce, p.sig, Date.now());
    } catch { // same nonce used before, or this role already answered
      fail(q.approval.get(r.request_id, role) ? 'ALREADY_ANSWERED' : 'BAD_INPUT');
    }
  }

  // ---- handlers ----
  const handlers = {
    [EV.USER_REGISTER](socket, p) {
      throttle(regRate, clientAddress(socket), registerPerMin);
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 20) fail('BAD_INPUT');
      if (!isP256Spki(p.signPub) || !isP256Spki(p.exchPub)) fail('BAD_INPUT');
      signedChallenge(socket, p.signPub, p.sig); // proves the phone holds the private key
      const userId = newId();
      q.insUser.run(userId, p.name.trim(), p.signPub, p.exchPub, Date.now());
      authed(socket, userId);
      return { userId };
    },

    [EV.AUTH_LOGIN](socket, p) {
      const u = (typeof p.userId === 'string' && q.user.get(p.userId)) || fail('UNKNOWN_USER');
      signedChallenge(socket, u.sign_pub, p.sig);
      authed(socket, u.user_id);
      setImmediate(() => safe(() => resendPending(u.user_id)));
      return { user: { id: u.user_id, name: u.name } };
    },

    [EV.CIRCLE_LIST](socket) {
      const friends = q.friends.all({ u: socket.data.userId }).map((u) => ({ ...pub(u), pairedAt: u.paired_at }));
      return { friends };
    },

    [EV.PAIR_OFFER](socket) {
      throttle(offerRate, socket.data.userId, cfg.OFFERS_PER_MIN);
      let token = '';
      for (const b of crypto.randomBytes(8)) token += cfg.TOKEN_ALPHABET[b % cfg.TOKEN_ALPHABET.length];
      const expiresAt = Date.now() + cfg.PAIR_TOKEN_TTL_MS;
      q.insToken.run(token, socket.data.userId, expiresAt);
      return { token, expiresAt };
    },

    [EV.PAIR_ACCEPT](socket, p) {
      const me = socket.data.userId;
      throttle(pairRate, me, cfg.PAIR_ATTEMPTS_PER_MIN);
      const code = String(p.token || '').toUpperCase().replace(/[\s-]/g, '');
      const t = q.token.get(code);
      if (!t || t.used || t.expires_at < Date.now()) fail('TOKEN_INVALID');
      if (t.user_id === me) fail('SELF_PAIR');
      if (isPaired(t.user_id, me)) fail('ALREADY_PAIRED');
      if (!q.useToken.run(t.token).changes) fail('TOKEN_INVALID');
      q.insPair.run(...orderedPair(t.user_id, me), Date.now());
      emitTo(t.user_id, EV.PAIR_COMPLETED, { peer: pub(q.user.get(me)) });
      return { peer: pub(q.user.get(t.user_id)) };
    },

    [EV.VERIFY_REQUEST](socket, p) {
      const me = socket.data.userId;
      const { claimedId, amountCents, method, channel, text, imageDataUrl } = p;
      if (typeof claimedId !== 'string' || !HEX32.test(claimedId)) fail('BAD_INPUT');
      if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > cfg.MAX_AMOUNT_CENTS) fail('BAD_INPUT');
      if (!METHODS.includes(method) || !cfg.CHANNELS.includes(channel)) fail('BAD_INPUT');
      if (text != null && (typeof text !== 'string' || text.length > cfg.MAX_TEXT_CHARS)) fail('BAD_INPUT');
      if (imageDataUrl != null && (typeof imageDataUrl !== 'string' || imageDataUrl.length > cfg.MAX_IMAGE_DATAURL_CHARS
        || !IMAGE_URL.test(imageDataUrl))) fail('BAD_INPUT');
      if (!q.user.get(claimedId) || !isPaired(me, claimedId)) fail('NOT_PAIRED');
      throttle(rate, me, cfg.RATE_LIMIT_PER_MIN);

      const firstRequest = !q.priorReq.get({ a: me, b: claimedId });
      const tier = tierFor(amountCents);
      const requestId = newId();
      q.insReq.run(requestId, me, claimedId, amountCents, method, channel, tier,
        JSON.stringify(firstRequest ? ['FIRST_REQUEST'] : []), cfg.METHOD_RISK[method], firstRequest ? 1 : 0,
        text ? sha256hex(normalizeText(text)) : null, Date.now());
      const r = q.req.get(requestId);

      // Text and image are used for analysis here and dropped. They are never written anywhere.
      const job = analyzeSafe({
        text, imageBase64: imageDataUrl ? imageDataUrl.replace(IMAGE_URL, '') : undefined,
        amount: amountCents / 100, paymentMethod: method, claimedName: q.user.get(claimedId).name, firstRequest,
      }, { analyze }).then((a) => {
        q.setAnalysis.run(JSON.stringify(a.tags), a.paymentRisk, a.explanation, a.source, requestId);
      }).finally(() => analyses.delete(requestId));
      analyses.set(requestId, job);
      job.then(() => safe(() => pushUpdate(requestId)));

      // After the ack has gone out, so the phone knows the requestId before the first update.
      setImmediate(() => safe(() => { emitTo(claimedId, EV.VERIFY_PROMPT, promptFor(r)); pushUpdate(requestId); }));
      return { requestId };
    },

    async [EV.VERIFY_ANSWER](socket, p) {
      const me = socket.data.userId;
      const r = (typeof p.requestId === 'string' && q.req.get(p.requestId)) || fail('NOT_FOUND');
      if (r.claimed_id !== me) fail('NOT_ALLOWED');
      if (q.approval.get(r.request_id, 'claimed')) fail('ALREADY_ANSWERED');
      if (r.status !== 'open') fail('NOT_ALLOWED'); // timed out
      if (!['yes', 'not_me'].includes(p.answer)) fail('BAD_INPUT');
      checkNonceTs(p.ts, p.nonce);
      // The retype stops a reflex tap on Yes. It must never block a Not me.
      if (p.answer === 'yes' && r.tier >= 2 && p.retypedCents !== r.amount_cents) fail('AMOUNT_MISMATCH');
      const signed = answerString({
        requestId: r.request_id, checkerId: r.checker_id, claimedId: r.claimed_id,
        amountCents: r.amount_cents, method: r.method, answer: p.answer, ts: p.ts, nonce: p.nonce,
      });
      if (typeof p.sig !== 'string' || !verifySig(q.user.get(me).sign_pub, signed, p.sig)) fail('BAD_SIGNATURE');
      storeApproval(r, me, 'claimed', p);
      q.setStatus.run('answered', r.request_id);
      if (p.answer === 'not_me') alertFriends(r);
      else if (r.tier === 3) promptSecond(r);
      await analyses.get(r.request_id);
      pushUpdate(r.request_id);
      return {};
    },

    [EV.VERIFY_WORDCHECK](socket, p) {
      const r = (typeof p.requestId === 'string' && q.req.get(p.requestId)) || fail('NOT_FOUND');
      if (r.checker_id !== socket.data.userId) fail('NOT_ALLOWED');
      if (r.status === 'timed_out') fail('NOT_ALLOWED');
      if (p.passed !== true) fail('BAD_INPUT');
      q.setWord.run(r.request_id);
      pushUpdate(r.request_id);
      return {};
    },

    [EV.VERIFY_CONFIRM](socket, p) {
      const me = socket.data.userId;
      const r = (typeof p.requestId === 'string' && q.req.get(p.requestId)) || fail('NOT_FOUND');
      if (r.second_user_id !== me) fail('NOT_ALLOWED');
      if (q.approval.get(r.request_id, 'second')) fail('ALREADY_ANSWERED');
      if (!['yes', 'no'].includes(p.answer)) fail('BAD_INPUT');
      checkNonceTs(p.ts, p.nonce);
      const signed = confirmString({
        requestId: r.request_id, confirmerId: me, claimedId: r.claimed_id,
        amountCents: r.amount_cents, answer: p.answer, ts: p.ts, nonce: p.nonce,
      });
      if (typeof p.sig !== 'string' || !verifySig(q.user.get(me).sign_pub, signed, p.sig)) fail('BAD_SIGNATURE');
      storeApproval(r, me, 'second', p);
      if (p.answer === 'no') alertFriends(r);
      pushUpdate(r.request_id);
      return {};
    },
  };

  io.on('connection', (socket) => {
    freshChallenge(socket);
    for (const [ev, fn] of Object.entries(handlers)) {
      socket.on(ev, async (payload, ack) => {
        try {
          if (!PRE_AUTH.has(ev) && !socket.data.userId) fail('UNAUTHENTICATED');
          const result = await fn(socket, payload && typeof payload === 'object' ? payload : {});
          if (typeof ack === 'function') ack({ ok: true, ...result });
        } catch (e) {
          const code = e instanceof ProtocolError ? e.code : 'SERVER_ERROR';
          if (code === 'SERVER_ERROR') log(`error in ${ev}: ${e.message}`); // message only, never the payload
          if (typeof ack === 'function') ack({ ok: false, error: code });
        }
      });
    }
  });

  // 2 minutes with no answer -> amber. Polling survives restarts and needs no per-request timers.
  function sweep() {
    for (const { request_id } of q.expired.all(Date.now() - timeoutMs)) {
      q.setStatus.run('timed_out', request_id);
      pushUpdate(request_id);
    }
  }
  const sweeper = setInterval(() => safe(sweep), sweepMs);
  sweeper.unref();

  // Soft reset: clear requests, approvals, alerts and counters. Users and pairs stay, so the pre-paired demo phones
  // keep working and the next request is a "first request" again. Hard reset also deletes users and pairs.
  function resetDemo(hard) {
    db.transaction(() => {
      for (const t of ['approvals', 'alerts', 'verify_requests', 'pair_tokens']) db.exec(`DELETE FROM ${t}`);
      if (hard) for (const t of ['pairs', 'users']) db.exec(`DELETE FROM ${t}`);
    })();
    rate.clear(); pairRate.clear(); offerRate.clear(); regRate.clear(); analyses.clear();
    io.emit(EV.DEMO_RESET, { hard });
    log(`demo reset hard=${hard}`);
    return { hard, users: db.prepare('SELECT COUNT(*) n FROM users').get().n };
  }

  function demoStatus() {
    const users = db.prepare('SELECT user_id, name FROM users ORDER BY created_at').all();
    return {
      users: users.map((u) => ({ name: u.name, online: isOnline(u.user_id), friends: q.friends.all({ u: u.user_id }).length })),
      pairs: db.prepare('SELECT COUNT(*) n FROM pairs').get().n,
      openRequests: db.prepare("SELECT COUNT(*) n FROM verify_requests WHERE status = 'open'").get().n,
    };
  }

  return {
    httpServer, io, db,
    listen: (port) => new Promise((res) => httpServer.listen(port, () => res(httpServer.address().port))),
    close: () => new Promise((res) => {
      clearInterval(sweeper);
      io.close(() => { db.close(); res(); });
    }),
  };
}
