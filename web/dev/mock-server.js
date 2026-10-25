// PROTOCOL v2 reference server (in memory, dev only). Lets the phone app and tests run before the real server speaks v2.
// Shivaan: copy any of this. It uses web/js/lib/canonical.js + crypto.js, the same code the phones use.
//   node web/dev/mock-server.js          -> http://localhost:3000  (serves web/ too)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { authString, answerString, confirmString, randomNonce, METHODS } from '../js/lib/canonical.js';
import { verifyString } from '../js/lib/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RISK = { gift_card: 'high', wire: 'high', crypto: 'high', venmo_cashapp_zelle: 'medium' };
const CHANNELS = ['text', 'call', 'dm', 'email'];

class ProtocolError extends Error {}
const fail = (code) => { throw new ProtocolError(code); };

export function createMockServer({ webDir = path.join(here, '..'), timeoutMs = 120000, log = () => {} } = {}) {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(webDir));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  const users = new Map();      // id -> { id, name, signPub, exchPub }
  const pairs = new Set();      // "a|b" sorted
  const tokens = new Map();     // token -> { userId, expiresAt }
  const requests = new Map();   // id -> request
  const usedNonces = new Set();
  const pairKey = (a, b) => [a, b].sort().join('|');
  const friendsOf = (id) => [...users.values()].filter((u) => u.id !== id && pairs.has(pairKey(id, u.id)));
  const pub = (u) => ({ id: u.id, name: u.name, signPub: u.signPub, exchPub: u.exchPub });
  const fresh = (ts) => Number.isInteger(ts) && Math.abs(Date.now() - ts) <= 5 * 60 * 1000;
  const useNonce = (id, nonce) => {
    const k = `${id}:${nonce}`;
    if (usedNonces.has(k)) fail('BAD_INPUT');
    usedNonces.add(k);
  };

  function decide(r) {
    const risk = RISK[r.method] || 'low';
    const needs = { word: r.tier >= 2, second: r.tier === 3 };
    const reasons = [];
    let verdict;
    if (r.answer === 'not_me' || r.secondNo) {
      verdict = 'red';
      reasons.push(r.secondNo ? 'A second person in the circle said no.' : `${users.get(r.claimedId).name} says this was not them.`);
    } else if (r.answer === 'timeout') {
      verdict = 'amber'; reasons.push("No reply. Ask for your word, or don't send.");
    } else if (r.answer === 'none') {
      verdict = 'amber'; reasons.push('Waiting for their phone.');
    } else if (risk === 'high') {
      verdict = 'amber'; reasons.push('Gift cards, wires and crypto are how scams get paid. Be careful.');
    } else if (needs.word && !r.wordOk) {
      verdict = 'amber'; reasons.push('Ask them for your shared word.');
    } else if (needs.second && r.confirms < 1) {
      verdict = 'amber';
      reasons.push(r.noThird ? 'Add a third member to your circle' : 'Waiting for a second person to confirm.');
    } else verdict = 'green';
    return { verdict, reasons, needs, risk };
  }

  function payload(r) {
    const d = decide(r);
    return {
      requestId: r.id, checkerId: r.checkerId, claimedId: r.claimedId, verdict: d.verdict, tier: r.tier, reasons: d.reasons, needs: d.needs,
      stages: {
        information: { claimedName: users.get(r.claimedId).name, amountCents: r.amountCents, method: r.method, channel: r.channel },
        understanding: { tags: [], paymentRisk: d.risk, explanation: '', firstRequest: false },
        confidence: { answer: r.answer, wordOk: r.wordOk, approvals: { needed: d.needs.second ? 1 : 0, received: r.confirms }, answerSig: r.answerSig },
      },
    };
  }
  const push = (r) => io.to(`user:${r.checkerId}`).emit('verify:update', payload(r));

  function alertFriends(r) {
    const claimed = users.get(r.claimedId);
    for (const f of friendsOf(claimed.id)) {
      io.to(`user:${f.id}`).emit('circle:alert', { impersonatedName: claimed.name, claimedId: claimed.id, requestId: r.id, ts: Date.now() });
    }
  }

  io.on('connection', (socket) => {
    const nonce = randomNonce();
    socket.data.nonce = nonce;
    socket.emit('auth:challenge', { nonce });

    const on = (event, needsAuth, fn) => socket.on(event, async (payloadIn, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (needsAuth && !socket.data.userId) fail('UNAUTHENTICATED');
        const out = await fn(payloadIn || {});
        reply({ ok: true, ...(out || {}) });
      } catch (e) {
        reply({ ok: false, error: e instanceof ProtocolError ? e.message : 'BAD_INPUT' });
        if (!(e instanceof ProtocolError)) log('error', event, e && e.message);
      }
    });

    on('user:register', false, async (p) => {
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 20 || !p.signPub || !p.exchPub) fail('BAD_INPUT');
      if (!(await verifyString(p.signPub, p.sig, authString(socket.data.nonce)))) fail('BAD_SIGNATURE');
      const id = randomNonce();
      users.set(id, { id, name, signPub: p.signPub, exchPub: p.exchPub });
      socket.data.userId = id;
      socket.join(`user:${id}`);
      return { userId: id };
    });

    on('auth:login', false, async (p) => {
      const u = users.get(p.userId);
      if (!u) fail('UNKNOWN_USER');
      if (!(await verifyString(u.signPub, p.sig, authString(socket.data.nonce)))) fail('BAD_SIGNATURE');
      socket.data.userId = u.id;
      socket.join(`user:${u.id}`);
      return { user: { id: u.id, name: u.name } };
    });

    on('pair:offer', true, () => {
      let token = '';
      for (let i = 0; i < 8; i++) token += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
      const expiresAt = Date.now() + 5 * 60 * 1000;
      tokens.set(token, { userId: socket.data.userId, expiresAt });
      return { token, expiresAt };
    });

    on('pair:accept', true, (p) => {
      const t = tokens.get(String(p.token || '').toUpperCase());
      if (!t || t.expiresAt < Date.now()) fail('TOKEN_INVALID');
      if (t.userId === socket.data.userId) fail('SELF_PAIR');
      if (pairs.has(pairKey(t.userId, socket.data.userId))) fail('ALREADY_PAIRED');
      tokens.delete(String(p.token).toUpperCase());
      pairs.add(pairKey(t.userId, socket.data.userId));
      io.to(`user:${t.userId}`).emit('pair:completed', { peer: pub(users.get(socket.data.userId)) });
      return { peer: pub(users.get(t.userId)) };
    });

    on('circle:list', true, () => ({
      friends: friendsOf(socket.data.userId).map((u) => ({ ...pub(u), pairedAt: Date.now() })),
    }));

    on('verify:request', true, (p) => {
      const me = socket.data.userId;
      if (!users.has(p.claimedId) || !pairs.has(pairKey(me, p.claimedId))) fail('NOT_PAIRED');
      if (!Number.isInteger(p.amountCents) || p.amountCents <= 0 || !METHODS.includes(p.method) || !CHANNELS.includes(p.channel)) fail('BAD_INPUT');
      if (p.text != null && String(p.text).length > 2000) fail('BAD_INPUT');
      const tier = p.amountCents < 2500 ? 1 : p.amountCents <= 20000 ? 2 : 3;
      const r = {
        id: randomNonce(), checkerId: me, claimedId: p.claimedId, amountCents: p.amountCents, method: p.method, channel: p.channel,
        tier, answer: 'none', wordOk: false, confirms: 0, secondNo: false, secondId: null, answerSig: null, noThird: false, done: false,
      };
      requests.set(r.id, r);
      const checker = users.get(me);
      io.to(`user:${r.claimedId}`).emit('verify:prompt', {
        requestId: r.id, checker: { id: checker.id, name: checker.name }, amountCents: r.amountCents, method: r.method, channel: r.channel, tier, ts: Date.now(),
      });
      r.timer = setTimeout(() => { if (r.answer === 'none') { r.answer = 'timeout'; push(r); } }, timeoutMs);
      r.timer.unref?.();
      setImmediate(() => push(r));
      return { requestId: r.id };
    });

    on('verify:answer', true, async (p) => {
      const r = requests.get(p.requestId);
      if (!r) fail('NOT_FOUND');
      if (r.claimedId !== socket.data.userId) fail('NOT_ALLOWED');
      if (r.answer !== 'none') fail('ALREADY_ANSWERED');
      if (!['yes', 'not_me'].includes(p.answer) || !fresh(p.ts)) fail('BAD_INPUT');
      const str = answerString({ requestId: r.id, checkerId: r.checkerId, claimedId: r.claimedId, amountCents: r.amountCents, method: r.method, answer: p.answer, ts: p.ts, nonce: p.nonce });
      if (!(await verifyString(users.get(r.claimedId).signPub, p.sig, str))) fail('BAD_SIGNATURE');
      if (r.tier >= 2 && p.answer === 'yes' && p.retypedCents !== r.amountCents) fail('AMOUNT_MISMATCH');
      useNonce(r.claimedId, p.nonce);
      clearTimeout(r.timer);
      r.answer = p.answer;
      r.answerSig = { answer: p.answer, ts: p.ts, nonce: p.nonce, sig: p.sig };
      if (p.answer === 'not_me') alertFriends(r);
      if (p.answer === 'yes' && r.tier === 3) {
        const others = friendsOf(r.claimedId).filter((f) => f.id !== r.checkerId);
        if (others.length) {
          r.secondId = others[0].id;
          io.to(`user:${r.secondId}`).emit('verify:confirm_prompt', {
            requestId: r.id, claimedId: r.claimedId, checkerName: users.get(r.checkerId).name, claimedName: users.get(r.claimedId).name,
            amountCents: r.amountCents, method: r.method,
          });
        } else r.noThird = true;
      }
      push(r);
    });

    on('verify:wordcheck', true, (p) => {
      const r = requests.get(p.requestId);
      if (!r) fail('NOT_FOUND');
      if (r.checkerId !== socket.data.userId) fail('NOT_ALLOWED');
      if (p.passed === true && r.answer === 'yes') { r.wordOk = true; push(r); }
    });

    on('verify:confirm', true, async (p) => {
      const r = requests.get(p.requestId);
      if (!r) fail('NOT_FOUND');
      if (r.secondId !== socket.data.userId) fail('NOT_ALLOWED');
      if (r.confirmed) fail('ALREADY_ANSWERED');
      if (!['yes', 'no'].includes(p.answer) || !fresh(p.ts)) fail('BAD_INPUT');
      const str = confirmString({ requestId: r.id, confirmerId: socket.data.userId, claimedId: r.claimedId, amountCents: r.amountCents, answer: p.answer, ts: p.ts, nonce: p.nonce });
      if (!(await verifyString(users.get(socket.data.userId).signPub, p.sig, str))) fail('BAD_SIGNATURE');
      useNonce(socket.data.userId, p.nonce);
      r.confirmed = true;
      if (p.answer === 'yes') r.confirms = 1; else { r.secondNo = true; alertFriends(r); }
      push(r);
    });
  });

  return {
    httpServer,
    listen: (port = 0) => new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port))),
    close: () => new Promise((resolve) => { io.close(); httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = createMockServer({ log: console.log });
  s.listen(Number(process.env.PORT) || 3000).then((p) => console.log(`Vouch v2 reference server on http://localhost:${p}`));
}
