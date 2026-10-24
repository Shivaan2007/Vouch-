import test from 'node:test';
import assert from 'node:assert/strict';
import { WORDS } from '../js/lib/words.js';
import { authString, answerString, confirmString, wordMessage, randomNonce, bytesToB64, b64ToBytes, bytesToHex } from '../js/lib/canonical.js';
import {
  createIdentityKeys, exportPub, signString, verifyString, deriveWordKey, wordAt, currentWord,
  checkWord, safetyCode, verifyAnswer, signAnswer, signConfirm,
} from '../js/lib/crypto.js';

async function makeUser() {
  const keys = await createIdentityKeys();
  return { keys, signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
}

test('WORDS: 1296 unique lowercase, first acid, last zoom', () => {
  assert.equal(WORDS.length, 1296);
  assert.equal(new Set(WORDS).size, 1296);
  assert.ok(WORDS.every((w) => w === w.toLowerCase()));
  assert.equal(WORDS[0], 'acid');
  assert.equal(WORDS[1295], 'zoom');
});

test('canonical: exact strings and validation', () => {
  assert.equal(authString('abc123'), 'vouch|v2|auth|abc123');
  const a = { requestId: 'r1', checkerId: 'c1', claimedId: 'f1', amountCents: 6000, method: 'venmo_cashapp_zelle', answer: 'yes', ts: 1700000000000, nonce: 'n1' };
  assert.equal(answerString(a), 'vouch|v2|answer|r1|c1|f1|6000|venmo_cashapp_zelle|yes|1700000000000|n1');
  const c = { requestId: 'r1', confirmerId: 'x1', claimedId: 'f1', amountCents: 30000, answer: 'no', ts: 1700000000000, nonce: 'n2' };
  assert.equal(confirmString(c), 'vouch|v2|confirm|r1|x1|f1|30000|no|1700000000000|n2');
  assert.equal(wordMessage(29000000), 'vouch-word|v2|29000000');
  assert.throws(() => answerString({ ...a, answer: 'maybe' }), TypeError);
  assert.throws(() => answerString({ ...a, method: 'bitcoin' }), TypeError);
  assert.throws(() => answerString({ ...a, amountCents: 60.5 }), TypeError);
  assert.throws(() => answerString({ ...a, ts: '1' }), TypeError);
  assert.throws(() => answerString({ ...a, requestId: undefined }), TypeError);
  assert.throws(() => confirmString({ ...c, answer: 'not_me' }), TypeError);
  assert.match(randomNonce(), /^[0-9a-f]{32}$/);
  assert.equal(bytesToHex(b64ToBytes(bytesToB64(new Uint8Array([0, 255, 16])))), '00ff10');
});

test('sign/verify round trip and tampering', async () => {
  const u = await makeUser();
  const sig = await signString(u.keys.signKeyPair.privateKey, 'hello');
  assert.equal(b64ToBytes(sig).length, 64);
  assert.equal(await verifyString(u.signPub, sig, 'hello'), true);
  assert.equal(await verifyString(u.signPub, sig, 'hellO'), false);
  const bad = b64ToBytes(sig);
  bad[10] ^= 1;
  assert.equal(await verifyString(u.signPub, bytesToB64(bad), 'hello'), false);
  assert.equal(await verifyString('not-a-key', sig, 'hello'), false);
  assert.equal(await verifyString(u.signPub, 'not base64!!', 'hello'), false);
});

test('two identities derive identical words both ways', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const ka = await deriveWordKey(a.keys.exchKeyPair.privateKey, b.exchPub);
  const kb = await deriveWordKey(b.keys.exchKeyPair.privateKey, a.exchPub);
  const base = Math.floor(Date.now() / 60000);
  for (let i = 0; i < 5; i++) {
    const w1 = await wordAt(ka, base + i * 7);
    const w2 = await wordAt(kb, base + i * 7);
    assert.equal(w1, w2);
    assert.match(w1, /^\S+ \S+$/);
  }
});

test('checkWord accepts current and previous minute, rejects others', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const k = await deriveWordKey(a.keys.exchKeyPair.privateKey, b.exchPub);
  const now = 1_700_000_030_000;
  const m = Math.floor(now / 60000);
  const cur = await wordAt(k, m);
  const prev = await wordAt(k, m - 1);
  assert.equal(await checkWord(k, cur, now), true);
  assert.equal(await checkWord(k, `  ${cur.toUpperCase().replace(' ', '   ')} `, now), true);
  assert.equal(await checkWord(k, prev, now), true);
  const old = await wordAt(k, m - 2);
  const next = await wordAt(k, m + 1);
  if (old !== cur && old !== prev) assert.equal(await checkWord(k, old, now), false);
  if (next !== cur && next !== prev) assert.equal(await checkWord(k, next, now), false);
  assert.equal(await checkWord(k, '', now), false);
  const cw = await currentWord(k, now);
  assert.equal(cw.word, cur);
  assert.equal(cw.minute, m);
  assert.ok(cw.secondsLeft >= 1 && cw.secondsLeft <= 60);
});

test('safetyCode is symmetric and well-formed', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const c1 = await safetyCode(a, b);
  const c2 = await safetyCode(b, a);
  assert.equal(c1, c2);
  assert.match(c1, /^\d{3} \d{3}$/);
});

test('verifyAnswer', async () => {
  const friend = await makeUser();
  const f = { requestId: 'r1', checkerId: 'c1', claimedId: 'f1', amountCents: 6000, method: 'venmo_cashapp_zelle', answer: 'yes' };
  const s = await signAnswer(friend.keys.signKeyPair.privateKey, f);
  const mk = (over = {}, sigOver = {}) => ({
    requestId: f.requestId, checkerId: f.checkerId, claimedId: f.claimedId,
    stages: {
      information: { claimedName: 'F', amountCents: f.amountCents, method: f.method, channel: 'text', ...over },
      confidence: { answer: 'yes', answerSig: { answer: 'yes', ts: s.ts, nonce: s.nonce, sig: s.sig, ...sigOver } },
    },
  });
  assert.equal(await verifyAnswer(mk(), friend.signPub), true);
  assert.equal(await verifyAnswer(mk({ amountCents: 7000 }), friend.signPub), false);
  assert.equal(await verifyAnswer(mk({ method: 'wire' }), friend.signPub), false);
  assert.equal(await verifyAnswer(mk({}, { answer: 'not_me' }), friend.signPub), false);
  assert.equal(await verifyAnswer(mk({}, { nonce: randomNonce() }), friend.signPub), false);
  const other = mk();
  other.checkerId = 'c2';
  assert.equal(await verifyAnswer(other, friend.signPub), false);
  const none = mk();
  none.stages.confidence.answerSig = null;
  assert.equal(await verifyAnswer(none, friend.signPub), false);
  assert.equal(await verifyAnswer({}, friend.signPub), false);
});

test('signConfirm produces a verifiable signature', async () => {
  const u = await makeUser();
  const f = { requestId: 'r1', confirmerId: 'x1', claimedId: 'f1', amountCents: 30000, answer: 'yes' };
  const s = await signConfirm(u.keys.signKeyPair.privateKey, f);
  assert.equal(await verifyString(u.signPub, s.sig, confirmString({ ...f, ts: s.ts, nonce: s.nonce })), true);
});

test('private keys are non-extractable', async () => {
  const k = await createIdentityKeys();
  await assert.rejects(globalThis.crypto.subtle.exportKey('pkcs8', k.signKeyPair.privateKey));
  await assert.rejects(globalThis.crypto.subtle.exportKey('pkcs8', k.exchKeyPair.privateKey));
  const a = await makeUser();
  const wk = await deriveWordKey(k.exchKeyPair.privateKey, a.exchPub);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', wk));
});
