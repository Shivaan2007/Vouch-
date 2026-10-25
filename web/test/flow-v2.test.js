// End-to-end PROTOCOL v2 flow: real phone-side crypto (web/js/lib) against the v2 reference server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createMockServer } from '../dev/mock-server.js';
import { authString } from '../js/lib/canonical.js';
import {
  createIdentityKeys, exportPub, signString, signAnswer, signConfirm, deriveWordKey, currentWord, checkWord, verifyAnswer, safetyCode,
} from '../js/lib/crypto.js';

let server; let url;
// VOUCH_SERVER=real runs the same flow against the real server (server/src/app.js) instead of the reference one.
before(async () => {
  if (process.env.VOUCH_SERVER === 'real') {
    const { createVouchServer } = await import('../../server/src/app.js');
    server = createVouchServer({ log: () => {} });
  } else server = createMockServer();
  url = `http://localhost:${await server.listen(0)}`;
});
after(async () => { for (const p of phones) p.socket.close(); await server.close(); });

const phones = [];

/** A fake phone: keys + socket, registered with the server. */
async function phone(name) {
  const keys = await createIdentityKeys();
  const pubs = { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
  const socket = io(url, { transports: ['websocket'] });
  const inbox = [];
  const waiters = [];
  socket.onAny((event, payload) => {
    inbox.push({ event, payload });
    for (const w of [...waiters]) if (w.try()) waiters.splice(waiters.indexOf(w), 1);
  });
  const nonce = await new Promise((resolve) => socket.once('auth:challenge', (m) => resolve(m.nonce)));
  const call = (event, body = {}) => new Promise((resolve) => socket.emit(event, body, resolve));
  const sig = await signString(keys.signKeyPair.privateKey, authString(nonce));
  const res = await call('user:register', { name, ...pubs, sig });
  assert.equal(res.ok, true, `register ${name}`);
  const p = {
    name, id: res.userId, keys, pubs, socket, call,
    next: (event, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event} on ${name}`)), ms);
      const tryNow = () => {
        const i = inbox.findIndex((m) => m.event === event && pred(m.payload));
        if (i < 0) return false;
        clearTimeout(t); resolve(inbox.splice(i, 1)[0].payload); return true;
      };
      if (!tryNow()) waiters.push({ try: tryNow });
    }),
  };
  phones.push(p);
  return p;
}

async function pair(a, b) {
  const { token } = await a.call('pair:offer');
  const done = a.next('pair:completed');
  const acc = await b.call('pair:accept', { token });
  assert.equal(acc.ok, true);
  const completed = await done;
  assert.equal(completed.peer.id, b.id);
  // Both sides show the same safety code.
  assert.equal(await safetyCode(a.pubs, completed.peer), await safetyCode(b.pubs, acc.peer));
  return acc;
}

const J = async (checker, claimed, extra) => {
  const { requestId, ok, error } = await checker.call('verify:request', { claimedId: claimed.id, amountCents: 6000, method: 'venmo_cashapp_zelle', channel: 'text', ...extra });
  assert.equal(ok, true, error);
  return requestId;
};

async function answer(friend, prompt, ans, over = {}) {
  const fields = { requestId: prompt.requestId, checkerId: prompt.checker.id, claimedId: friend.id, amountCents: prompt.amountCents, method: prompt.method, answer: ans };
  const s = await signAnswer(friend.keys.signKeyPair.privateKey, fields);
  return friend.call('verify:answer', { requestId: prompt.requestId, answer: ans, ...over, ...s });
}

test('auth rules', async () => {
  const a = await phone('Ann');
  const raw = io(url, { transports: ['websocket'] });
  await new Promise((r) => raw.once('auth:challenge', r));
  const res = await new Promise((r) => raw.emit('circle:list', {}, r));
  assert.deepEqual(res, { ok: false, error: 'UNAUTHENTICATED' });
  raw.close();
  const bad = await new Promise((r) => { const s = io(url, { transports: ['websocket'] }); phones.push({ socket: s }); s.once('auth:challenge', () => s.emit('auth:login', { userId: 'f'.repeat(32), sig: 'AAAA' }, r)); });
  assert.equal(bad.error, 'UNKNOWN_USER');
  assert.equal((await a.call('pair:accept', { token: 'ZZZZZZZZ' })).error, 'TOKEN_INVALID');
  const { token } = await a.call('pair:offer');
  assert.equal((await a.call('pair:accept', { token })).error, 'SELF_PAIR');
});

test('tier 1: Yes is signed, and the checker phone verifies it before green', async () => {
  const friend = await phone('Fran'); const checker = await phone('Chet');
  await pair(friend, checker);
  const prompt = friend.next('verify:prompt');
  const requestId = await J(checker, friend, { amountCents: 2000 });
  const p = await prompt;
  assert.equal(p.requestId, requestId);
  assert.equal(p.tier, 1);
  assert.equal((await answer(friend, p, 'yes')).ok, true);
  const u = await checker.next('verify:update', (x) => x.verdict === 'green');
  assert.equal(await verifyAnswer(u, friend.pubs.signPub), true);
  // A forged update (amount changed) fails the phone-side check even if the server said green.
  const forged = structuredClone(u);
  forged.stages.information.amountCents = 20;
  assert.equal(await verifyAnswer(forged, friend.pubs.signPub), false);
  // Replaying the answer is refused.
  assert.equal((await answer(friend, p, 'yes')).error, 'ALREADY_ANSWERED');
});

test('Not me: red, and the circle gets an alert', async () => {
  const friend = await phone('Fay'); const checker = await phone('Cal'); const third = await phone('Tia');
  await pair(friend, checker); await pair(friend, third);
  const prompt = friend.next('verify:prompt');
  await J(checker, friend, { amountCents: 20000, method: 'gift_card' });
  const p = await prompt;
  // The phone sends the amount along with "Not me" at tier 2+, so the person never has to type it.
  assert.equal((await answer(friend, p, 'not_me', { retypedCents: p.amountCents })).ok, true);
  const u = await checker.next('verify:update', (x) => x.verdict === 'red');
  assert.equal(u.stages.confidence.answer, 'not_me');
  const alert = await third.next('circle:alert');
  assert.equal(alert.impersonatedName, 'Fay');
});

test('a forged signature is rejected', async () => {
  const friend = await phone('Finn'); const checker = await phone('Cora'); const liar = await phone('Mal');
  await pair(friend, checker);
  const prompt = friend.next('verify:prompt');
  await J(checker, friend, { amountCents: 1000 });
  const p = await prompt;
  const fields = { requestId: p.requestId, checkerId: p.checker.id, claimedId: friend.id, amountCents: p.amountCents, method: p.method, answer: 'yes' };
  const s = await signAnswer(liar.keys.signKeyPair.privateKey, fields);
  assert.equal((await friend.call('verify:answer', { requestId: p.requestId, answer: 'yes', ...s })).error, 'BAD_SIGNATURE');
});

test('tier 2: retype + shared word (both phones derive the same word)', async () => {
  const friend = await phone('Flo'); const checker = await phone('Cam');
  const acc = await pair(friend, checker);
  const prompt = friend.next('verify:prompt');
  await J(checker, friend, { amountCents: 6000 });
  const p = await prompt;
  assert.equal(p.tier, 2);
  assert.equal((await answer(friend, p, 'yes', { retypedCents: 5000 })).error, 'AMOUNT_MISMATCH');
  assert.equal((await answer(friend, p, 'yes', { retypedCents: 6000 })).ok, true);
  const amber = await checker.next('verify:update', (x) => x.stages.confidence.answer === 'yes');
  assert.equal(amber.verdict, 'amber');
  assert.equal(amber.needs.word, true);
  // Each phone derives its own key; the word they show is identical.
  const checkerKey = await deriveWordKey(checker.keys.exchKeyPair.privateKey, friend.pubs.exchPub);
  const friendKey = await deriveWordKey(friend.keys.exchKeyPair.privateKey, checker.pubs.exchPub);
  const said = (await currentWord(friendKey)).word;
  assert.equal(await checkWord(checkerKey, said), true);
  assert.equal(await checkWord(checkerKey, 'wrong words'), false);
  assert.equal((await checker.call('verify:wordcheck', { requestId: p.requestId, passed: true })).ok, true);
  const u = await checker.next('verify:update', (x) => x.verdict === 'green');
  assert.equal(u.stages.confidence.wordOk, true);
  assert.equal(await verifyAnswer(u, friend.pubs.signPub), true);
  void acc;
});

test('tier 3: needs a second circle member to confirm', async () => {
  const friend = await phone('Gus'); const checker = await phone('Cleo'); const second = await phone('Sam');
  await pair(friend, checker); await pair(friend, second);
  const prompt = friend.next('verify:prompt');
  await J(checker, friend, { amountCents: 30000 });
  const p = await prompt;
  assert.equal(p.tier, 3);
  assert.equal((await answer(friend, p, 'yes', { retypedCents: 30000 })).ok, true);
  const cp = await second.next('verify:confirm_prompt');
  assert.equal(cp.claimedId, friend.id);
  await checker.call('verify:wordcheck', { requestId: p.requestId, passed: true });
  const s = await signConfirm(second.keys.signKeyPair.privateKey, { requestId: cp.requestId, confirmerId: second.id, claimedId: cp.claimedId, amountCents: cp.amountCents, answer: 'yes' });
  assert.equal((await second.call('verify:confirm', { requestId: cp.requestId, answer: 'yes', ...s })).ok, true);
  const u = await checker.next('verify:update', (x) => x.verdict === 'green');
  const { needed, received } = u.stages.confidence.approvals;
  assert.ok(needed >= 1 && received >= needed, `approvals ${received}/${needed}`);
});
