import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import * as cfg from './config.js';
import { EV } from './events.js';
import { openDb } from './db.js';
import { verifySig, answerString, loginString, newId, sha256hex } from './sig.js';
import { decide, tierFor } from './decision.js';
import { analyzeSafe } from './analyze.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes, easy to type
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ProtocolError(code); };

function isP256Spki(b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch { return false; }
}

export function createVouchServer({
  dbPath = ':memory:',
  webDir = path.join(here, '..', '..', 'web'),
  timeoutMs = cfg.TIMEOUT_MS,
  sweepMs = 1000,
  analyze,
  log = (...a) => console.log(...a),
} = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(webDir));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 6 * 1024 * 1024 });

  const sockets = new Map();     // userId -> Set<socket>
  const challenges = new Map();  // userId -> { challenge, expires }
  const rate = new Map();        // userId -> [timestamps]
  const analyses = new Map();    // requestId -> Promise (analysis still running)

  const q = {
    user: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    insUser: db.prepare('INSERT INTO users VALUES (?,?,?,?,?)'),
    setName: db.prepare('UPDATE users SET name = ? WHERE user_id = ?'),
    insToken: db.prepare('INSERT INTO pair_tokens VALUES (?,?,?,0)'),
    token: db.prepare('SELECT * FROM pair_tokens WHERE token = ?'),
    useToken: db.prepare('UPDATE pair_tokens SET used = 1 WHERE token = ? AND used = 0'),
    pair: db.prepare('SELECT * FROM pairs WHERE user_a = ? AND user_b = ?'),
    insPair: db.prepare('INSERT INTO pairs VALUES (?,?,?,?)'),
    memberOf: db.prepare('SELECT circle_id FROM circle_members WHERE user_id = ?'),
    insCircle: db.prepare('INSERT INTO circles VALUES (?,?)'),
    insMember: db.prepare('INSERT OR IGNORE INTO circle_members VALUES (?,?,?)'),
    moveMembers: db.prepare('UPDATE circle_members SET circle_id = ? WHERE circle_id = ?'),
    delCircle: db.prepare('DELETE FROM circles WHERE circle_id = ?'),
    members: db.prepare(`SELECT u.* FROM circle_members m JOIN users u ON u.user_id = m.user_id
                         WHERE m.circle_id = ? ORDER BY m.joined_at, u.user_id`),
    pairedWith: db.prepare('SELECT 1 FROM pairs WHERE user_a = ? AND user_b = ?'),
    priorReq: db.prepare(`SELECT 1 FROM verify_requests WHERE
                          (requester_id = ? AND claimed_id = ?) OR (requester_id = ? AND claimed_id = ?) LIMIT 1`),
    insReq: db.prepare(`INSERT INTO verify_requests
      (request_id, requester_id, claimed_id, amount, payment_method, tier, first_request, text_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    req: db.prepare('SELECT * FROM verify_requests WHERE request_id = ?'),
    setAnalysis: db.prepare('UPDATE verify_requests SET tags=?, payment_risk=?, explanation=?, source=? WHERE request_id=?'),
    setStatus: db.prepare('UPDATE verify_requests SET status = ? WHERE request_id = ?'),
    setWord: db.prepare('UPDATE verify_requests SET word_ok = 1 WHERE request_id = ?'),
    setSecond: db.prepare('UPDATE verify_requests SET second_user_id = ? WHERE request_id = ?'),
    insApproval: db.prepare('INSERT INTO approvals (request_id,user_id,role,answer,ts,nonce,sig,created_at) VALUES (?,?,?,?,?,?,?,?)'),
    approval: db.prepare('SELECT * FROM approvals WHERE request_id = ? AND role = ?'),
    insAlert: db.prepare('INSERT INTO alerts (circle_id,request_id,impersonated_name,ts) VALUES (?,?,?,?)'),
    expired: db.prepare(`SELECT request_id FROM verify_requests WHERE status = 'open' AND created_at <= ?`),
    openFor: db.prepare(`SELECT * FROM verify_requests WHERE claimed_id = ? AND status = 'open' AND created_at > ?`),
    secondFor: db.prepare(`SELECT * FROM verify_requests WHERE second_user_id = ? AND status = 'answered'`),
    recentBy: db.prepare('SELECT request_id FROM verify_requests WHERE requester_id = ? AND created_at > ?'),
  };

  const orderedPair = (a, b) => (a < b ? [a, b] : [b, a]);
  const emitTo = (userId, ev, payload) => sockets.get(userId)?.forEach((s) => s.emit(ev, payload));
  const publicUser = (u) => ({ userId: u.user_id, name: u.name, signPub: u.sign_pub, ecdhPub: u.ecdh_pub });

  function attach(socket, userId) {
    socket.data.userId = userId;
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(socket);
  }

  function register({ userId, name, signPub, ecdhPub }) {
    if (!ID_RE.test(userId || '')) fail('bad_user_id');
    if (typeof name !== 'string' || !name.trim() || name.length > 40) fail('bad_name');
    if (!isP256Spki(signPub) || !isP256Spki(ecdhPub)) fail('bad_key');
    q.insUser.run(userId, name.trim(), signPub, ecdhPub, Date.now());
  }

  function requireAuth(socket) {
    return socket.data.userId || fail('not_authenticated');
  }

  // ---- circles ----
  function joinCircles(a, b) {
    const ca = q.memberOf.get(a)?.circle_id;
    const cb = q.memberOf.get(b)?.circle_id;
    const now = Date.now();
    let id = ca || cb;
    if (!id) { id = newId(8); q.insCircle.run(id, now); }
    if (ca && cb && ca !== cb) { q.moveMembers.run(ca, cb); q.delCircle.run(cb); }
    q.insMember.run(a, id, now);
    q.insMember.run(b, id, now);
    return id;
  }
  const circleOf = (userId) => q.memberOf.get(userId)?.circle_id;

  // ---- verdicts ----
  function buildVerdict(r) {
    const requester = q.user.get(r.requester_id);
    const claimed = q.user.get(r.claimed_id);
    const a = q.approval.get(r.request_id, 'claimed');
    const s = q.approval.get(r.request_id, 'second');
    const tags = JSON.parse(r.tags);
    const d = decide({
      answer: a ? a.answer : 'none', tags, paymentRisk: r.payment_risk, amount: r.amount,
      wordOk: !!r.word_ok, secondConfirms: s?.answer === 'yes' ? 1 : 0, secondNo: s?.answer === 'no',
      timedOut: r.status === 'timed_out',
    });
    const reasons = [...d.reasons];
    if (d.needs.second && a?.answer === 'yes' && !r.second_user_id && d.verdict === 'amber') {
      reasons.push('No second member available. Add a third member to your circle to approve large amounts.');
    }
    return {
      requestId: r.request_id, verdict: d.verdict, reasons, tier: d.tier, needs: d.needs,
      stages: {
        information: { claimedName: claimed.name, requesterName: requester.name, amount: r.amount, paymentMethod: r.payment_method },
        understanding: { tags, paymentRisk: r.payment_risk, explanation: r.explanation, firstRequest: !!r.first_request },
        confidence: {
          answer: a ? a.answer : 'none', wordOk: !!r.word_ok,
          approvals: { needed: d.tier === 3 ? 2 : 1, received: (a?.answer === 'yes' ? 1 : 0) + (s?.answer === 'yes' ? 1 : 0) },
          answerSig: a ? { ts: a.ts, nonce: a.nonce, sig: a.sig } : null,
        },
      },
    };
  }

  function pushVerdict(requestId) {
    const r = q.req.get(requestId);
    if (!r) return null;
    const v = buildVerdict(r);
    emitTo(r.requester_id, EV.VERIFY_VERDICT, v);
    emitTo(r.claimed_id, EV.VERIFY_VERDICT, v);
    log(`verdict ${requestId.slice(0, 8)} ${v.verdict} tier${v.tier}`);
    return v;
  }

  const promptFor = (r) => ({
    requestId: r.request_id, fromName: q.user.get(r.requester_id).name, amount: r.amount,
    paymentMethod: r.payment_method, tier: r.tier, ts: r.created_at,
  });

  function promptSecond(r) {
    const members = q.members.all(circleOf(r.claimed_id)).map((u) => u.user_id)
      .filter((id) => id !== r.requester_id && id !== r.claimed_id);
    if (!members.length) return;
    q.setSecond.run(members[0], r.request_id);
    emitTo(members[0], EV.VERIFY_CONFIRM_PROMPT, {
      requestId: r.request_id, fromName: q.user.get(r.requester_id).name,
      claimedName: q.user.get(r.claimed_id).name, amount: r.amount,
    });
  }

  // After a reconnect, resend anything still waiting on this user.
  function resendPending(userId) {
    const now = Date.now();
    for (const r of q.openFor.all(userId, now - timeoutMs)) emitTo(userId, EV.VERIFY_PROMPT, promptFor(r));
    for (const r of q.secondFor.all(userId)) {
      if (q.approval.get(r.request_id, 'second')) continue;
      emitTo(userId, EV.VERIFY_CONFIRM_PROMPT, {
        requestId: r.request_id, fromName: q.user.get(r.requester_id).name,
        claimedName: q.user.get(r.claimed_id).name, amount: r.amount,
      });
    }
    for (const { request_id } of q.recentBy.all(userId, now - 10 * 60 * 1000)) {
      const r = q.req.get(request_id);
      emitTo(userId, EV.VERIFY_VERDICT, buildVerdict(r));
    }
  }

  function checkSigned({ userId, requestId, answer, ts, nonce, sig }) {
    if (!['yes', 'not_me', 'no'].includes(answer)) fail('bad_answer');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > cfg.MAX_TS_AGE_MS) fail('stale_timestamp');
    if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) fail('bad_nonce');
    if (typeof sig !== 'string') fail('bad_signature');
    const u = q.user.get(userId);
    if (!u || !verifySig(u.sign_pub, answerString(requestId, answer, ts, nonce), sig)) fail('bad_signature');
  }

  function storeApproval(r, userId, role, p) {
    try {
      q.insApproval.run(r.request_id, userId, role, p.answer, p.ts, p.nonce, p.sig, Date.now());
    } catch { fail('replay'); } // same nonce, or this role already answered
  }

  // ---- handlers ----
  const handlers = {
    [EV.USER_REGISTER](socket, p) {
      if (q.user.get(p.userId)) fail('user_exists');
      register(p);
      attach(socket, p.userId);
      return { userId: p.userId };
    },

    [EV.AUTH_CHALLENGE](_socket, { userId }) {
      if (!q.user.get(userId)) fail('unknown_user'); // phone should user:register again (DB may have been wiped)
      const challenge = newId(16);
      challenges.set(userId, { challenge, expires: Date.now() + 60000 });
      return { challenge };
    },

    [EV.AUTH_LOGIN](socket, { userId, challenge, sig }) {
      const u = q.user.get(userId) || fail('unknown_user');
      const c = challenges.get(userId);
      challenges.delete(userId); // single use
      if (!c || c.challenge !== challenge || c.expires < Date.now()) fail('bad_challenge');
      if (typeof sig !== 'string' || !verifySig(u.sign_pub, loginString(userId, challenge), sig)) fail('bad_signature');
      attach(socket, userId);
      setImmediate(() => resendPending(userId));
      return { userId, name: u.name };
    },

    [EV.CIRCLE_LIST](socket) {
      const me = requireAuth(socket);
      const cid = circleOf(me);
      const friends = cid ? q.members.all(cid).filter((u) => u.user_id !== me).map((u) => ({
        ...publicUser(u), paired: !!q.pairedWith.get(...orderedPair(me, u.user_id)),
      })) : [];
      return { circleId: cid || null, friends };
    },

    [EV.PAIR_START](socket, { userId }) {
      const me = requireAuth(socket);
      if (userId !== me) fail('forbidden');
      let token = '';
      for (const b of crypto.randomBytes(8)) token += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
      const expiresAt = Date.now() + cfg.PAIR_TOKEN_TTL_MS;
      q.insToken.run(token, me, expiresAt);
      return { token, expiresAt };
    },

    [EV.PAIR_COMPLETE](socket, p) {
      const { userId, name, signPub, ecdhPub } = p;
      const t = q.token.get(String(p.token || '').toUpperCase());
      if (!t) fail('bad_token');
      if (t.used) fail('token_used');
      if (t.expires_at < Date.now()) fail('token_expired');
      if (t.user_id === userId) fail('cannot_pair_self');
      const existing = q.user.get(userId);
      if (existing) {
        if (socket.data.userId !== userId) fail('not_authenticated');
        if (existing.sign_pub !== signPub || existing.ecdh_pub !== ecdhPub) fail('key_mismatch');
        if (typeof name === 'string' && name.trim() && name.length <= 40) q.setName.run(name.trim(), userId);
      } else {
        register({ userId, name, signPub, ecdhPub });
        attach(socket, userId);
      }
      if (!q.useToken.run(t.token).changes) fail('token_used');
      const [ua, ub] = orderedPair(t.user_id, userId);
      let pair = q.pair.get(ua, ub);
      if (!pair) {
        pair = { pair_id: newId(8) };
        q.insPair.run(pair.pair_id, ua, ub, Date.now());
      }
      joinCircles(t.user_id, userId);
      const a = q.user.get(t.user_id);
      const b = q.user.get(userId);
      emitTo(t.user_id, EV.PAIR_DONE, { pairId: pair.pair_id, peer: publicUser(b) });
      emitTo(userId, EV.PAIR_DONE, { pairId: pair.pair_id, peer: publicUser(a) });
      return { pairId: pair.pair_id, peer: publicUser(a) };
    },

    async [EV.VERIFY_REQUEST](socket, p) {
      const me = requireAuth(socket);
      const { requestId, claimedUserId, amount, paymentMethod, text, imageBase64, ts } = p;
      if (!ID_RE.test(requestId || '')) fail('bad_request_id');
      if (q.req.get(requestId)) fail('duplicate_request');
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > cfg.MAX_AMOUNT) fail('bad_amount');
      if (!Object.hasOwn(cfg.METHOD_RISK, paymentMethod)) fail('bad_payment_method');
      if (text != null && (typeof text !== 'string' || text.length > 20000)) fail('bad_text');
      if (imageBase64 != null && (typeof imageBase64 !== 'string' || imageBase64.length > cfg.MAX_IMAGE_BASE64_CHARS)) fail('image_too_large');
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > cfg.MAX_TS_AGE_MS) fail('stale_timestamp');
      if (claimedUserId === me) fail('cannot_verify_self');
      const claimed = q.user.get(claimedUserId) || fail('unknown_friend');
      if (!q.pairedWith.get(...orderedPair(me, claimedUserId))) fail('not_paired');

      const now = Date.now();
      const hits = (rate.get(me) || []).filter((t) => now - t < 60000);
      if (hits.length >= cfg.RATE_LIMIT_PER_MIN) fail('rate_limited');
      hits.push(now);
      rate.set(me, hits);

      const firstRequest = !q.priorReq.get(me, claimedUserId, claimedUserId, me);
      const tier = tierFor(amount);
      q.insReq.run(requestId, me, claimedUserId, amount, paymentMethod, tier, firstRequest ? 1 : 0,
        text ? sha256hex(text) : null, now);
      const r = q.req.get(requestId);
      emitTo(claimedUserId, EV.VERIFY_PROMPT, promptFor(r));

      // Text and image are used here and dropped. They are never written anywhere.
      const job = analyzeSafe({
        text, imageBase64, amount, paymentMethod, claimedName: claimed.name, firstRequest,
      }, { analyze }).then((a) => {
        q.setAnalysis.run(JSON.stringify(a.tags), a.paymentRisk, a.explanation, a.source, requestId);
      }).finally(() => analyses.delete(requestId));
      analyses.set(requestId, job);
      job.then(() => pushVerdict(requestId));
      return { requestId, tier, needs: { word: tier >= 2, second: tier === 3 }, firstRequest };
    },

    async [EV.VERIFY_ANSWER](socket, p) {
      const me = requireAuth(socket);
      const r = q.req.get(p.requestId) || fail('unknown_request');
      if (r.claimed_id !== me) fail('forbidden');
      if (r.status === 'timed_out') fail('expired');
      if (r.status !== 'open') fail('already_answered');
      if (!['yes', 'not_me'].includes(p.answer)) fail('bad_answer');
      checkSigned({ userId: me, ...p });
      storeApproval(r, me, 'claimed', p);
      q.setStatus.run('answered', r.request_id);
      if (p.answer === 'not_me') {
        const cid = circleOf(me);
        const name = q.user.get(me).name;
        if (cid) {
          q.insAlert.run(cid, r.request_id, name, Date.now());
          for (const m of q.members.all(cid)) {
            emitTo(m.user_id, EV.CIRCLE_ALERT, { impersonatedName: name, requestId: r.request_id, ts: Date.now() });
          }
        }
      } else if (r.tier === 3) {
        promptSecond(r);
      }
      await analyses.get(r.request_id);
      pushVerdict(r.request_id);
      return {};
    },

    [EV.VERIFY_WORD](socket, p) {
      const me = requireAuth(socket);
      const r = q.req.get(p.requestId) || fail('unknown_request');
      if (r.requester_id !== me) fail('forbidden');
      if (r.status === 'timed_out') fail('expired');
      if (p.ok !== true) fail('bad_word_flag');
      q.setWord.run(r.request_id);
      pushVerdict(r.request_id);
      return {};
    },

    [EV.VERIFY_CONFIRM](socket, p) {
      const me = requireAuth(socket);
      const r = q.req.get(p.requestId) || fail('unknown_request');
      if (r.second_user_id !== me) fail('forbidden');
      if (!['yes', 'no'].includes(p.answer)) fail('bad_answer');
      checkSigned({ userId: me, ...p });
      storeApproval(r, me, 'second', p);
      pushVerdict(r.request_id);
      return {};
    },
  };

  io.on('connection', (socket) => {
    for (const [ev, fn] of Object.entries(handlers)) {
      socket.on(ev, async (payload, ack) => {
        try {
          const result = await fn(socket, payload && typeof payload === 'object' ? payload : {});
          if (typeof ack === 'function') ack({ ok: true, ...result });
        } catch (e) {
          const code = e instanceof ProtocolError ? e.code : 'server_error';
          if (code === 'server_error') log(`error in ${ev}: ${e.message}`); // message only, never the payload
          if (typeof ack === 'function') ack({ ok: false, error: code });
        }
      });
    }
    socket.on('disconnect', () => {
      const id = socket.data.userId;
      if (id) {
        sockets.get(id)?.delete(socket);
        if (!sockets.get(id)?.size) sockets.delete(id);
      }
    });
  });

  // 2 minutes with no answer -> amber "wait". Polling survives restarts and needs no per-request timers.
  function sweep() {
    for (const { request_id } of q.expired.all(Date.now() - timeoutMs)) {
      q.setStatus.run('timed_out', request_id);
      pushVerdict(request_id);
    }
  }
  const sweeper = setInterval(sweep, sweepMs);
  sweeper.unref();

  return {
    httpServer, io, db,
    listen: (port) => new Promise((res) => httpServer.listen(port, () => res(httpServer.address().port))),
    close: () => new Promise((res) => {
      clearInterval(sweeper);
      io.close(() => { db.close(); res(); });
    }),
  };
}
