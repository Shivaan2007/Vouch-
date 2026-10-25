import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, pair, request } from './helpers.js';
import { answerString } from '../../web/js/lib/canonical.js';

const update = (phone, rq, test) => phone.waitFor('verify:update', (v) => v.requestId === rq.requestId && (!test || test(v)));

// checker + claimed paired; optional third phone paired with the claimed person (their other friend)
async function trio(t, { third = true } = {}) {
  const [checker, claimed] = [await t.phone('Sayan'), await t.phone('Shivaan')];
  await pair(claimed, checker);
  const other = third ? await t.phone('Tejasv') : null;
  if (other) await pair(claimed, other);
  return { checker, claimed, other };
}

test('register, pair, exchange public keys, list friends', async () => {
  const t = await startServer();
  try {
    const [a, b] = [await t.phone('Shivaan'), await t.phone('Sayan')];
    assert.match(a.userId, /^[0-9a-f]{32}$/);
    const { token, expiresAt } = await a.call('pair:offer', {});
    assert.match(token, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
    assert.ok(expiresAt > Date.now());

    const res = await b.call('pair:accept', { token: `${token.slice(0, 4)}-${token.slice(4)}`.toLowerCase() }); // dash and case ignored
    assert.equal(res.ok, true);
    assert.deepEqual(res.peer, { id: a.userId, name: 'Shivaan', signPub: a.signPub, exchPub: a.exchPub });
    const done = await a.waitFor('pair:completed');
    assert.deepEqual(done.peer, { id: b.userId, name: 'Sayan', signPub: b.signPub, exchPub: b.exchPub });

    const list = await a.call('circle:list', {});
    assert.deepEqual(list.friends.map((f) => f.name), ['Sayan']);
    assert.ok(list.friends[0].pairedAt > 0);
  } finally { await t.stop(); }
});

test('auth: challenge, proof of key at register, login, unauthenticated calls refused', async () => {
  const t = await startServer();
  try {
    const raw = await t.phone('Nobody', { register: false });
    await raw.ready();
    assert.equal((await raw.call('circle:list', {})).error, 'UNAUTHENTICATED');
    assert.equal((await raw.call('pair:offer', {})).error, 'UNAUTHENTICATED');
    assert.equal((await raw.register({ sig: raw.signMsg('not the challenge') })).error, 'BAD_SIGNATURE');
    assert.equal((await raw.register({ name: '' })).error, 'BAD_INPUT');
    assert.equal((await raw.register({ name: 'x'.repeat(21) })).error, 'BAD_INPUT');
    assert.equal((await raw.register({ signPub: 'AAAA' })).error, 'BAD_INPUT');
    assert.equal((await raw.register()).ok, true);
    assert.equal((await raw.call('circle:list', {})).ok, true);

    // a second connection: login with the right key works, another phone's key does not
    const again = await t.phone('Again', { register: false });
    again.sign = raw.sign; again.exch = raw.exch; again.userId = raw.userId;
    await again.ready();
    const evil = await t.phone('Evil', { register: false });
    await evil.ready();
    assert.equal((await evil.login({ userId: raw.userId })).error, 'BAD_SIGNATURE');
    assert.equal((await evil.login({ userId: 'f'.repeat(32) })).error, 'UNKNOWN_USER');
    const ok = await again.login();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.user, { id: raw.userId, name: 'Nobody' });
    // the nonce is single use: replaying the same login signature on a new challenge fails
    const stale = again.signMsg(`vouch|v2|auth|${again.events.find((e) => e.ev === 'auth:challenge').payload.nonce}`);
    assert.equal((await again.login({ sig: stale })).error, 'BAD_SIGNATURE');
  } finally { await t.stop(); }
});

test('pairing: single-use, expiry, self, already paired, guess limit', async () => {
  const t = await startServer();
  try {
    const [a, b, c] = [await t.phone('A'), await t.phone('B'), await t.phone('C')];
    const { token } = await a.call('pair:offer', {});
    assert.equal((await a.call('pair:accept', { token })).error, 'SELF_PAIR');
    assert.equal((await b.call('pair:accept', { token })).ok, true);
    assert.equal((await c.call('pair:accept', { token })).error, 'TOKEN_INVALID');
    assert.equal((await c.call('pair:accept', { token: 'ZZZZZZZZ' })).error, 'TOKEN_INVALID');

    const again = await a.call('pair:offer', {});
    assert.equal((await b.call('pair:accept', { token: again.token })).error, 'ALREADY_PAIRED');

    const old = await a.call('pair:offer', {});
    t.server.db.prepare('UPDATE pair_tokens SET expires_at = ? WHERE token = ?').run(Date.now() - 1, old.token);
    assert.equal((await c.call('pair:accept', { token: old.token })).error, 'TOKEN_INVALID');

    let last;
    for (let i = 0; i < 12; i++) last = await c.call('pair:accept', { token: 'AAAAAAAA' });
    assert.equal(last.error, 'RATE_LIMITED');
  } finally { await t.stop(); }
});

test('tier 1 Yes -> green, and the signature in the update can be re-checked', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);
    assert.equal(rq.res.ok, true);
    assert.match(rq.requestId, /^[0-9a-f]{32}$/);

    const prompt = await claimed.waitFor('verify:prompt');
    assert.deepEqual(prompt.checker, { id: checker.userId, name: 'Sayan' });
    assert.equal(prompt.amountCents, 2000);
    assert.equal(prompt.tier, 1);
    assert.equal(prompt.channel, 'text');

    const created = await update(checker, rq);
    assert.equal(created.verdict, 'amber');
    assert.equal(created.stages.confidence.answer, 'none');
    assert.equal(created.stages.confidence.answerSig, null);

    const ans = claimed.signAnswer(rq, 'yes');
    assert.equal((await claimed.call('verify:answer', ans)).ok, true);
    const v = await update(checker, rq, (x) => x.verdict === 'green');
    assert.deepEqual([v.checkerId, v.claimedId, v.tier], [checker.userId, claimed.userId, 1]);
    assert.deepEqual(v.stages.information, { claimedName: 'Shivaan', amountCents: 2000, method: 'venmo_cashapp_zelle', channel: 'text' });
    assert.equal(v.stages.confidence.answer, 'yes');
    assert.deepEqual(v.stages.confidence.approvals, { needed: 1, received: 1 });
    assert.deepEqual(v.stages.confidence.answerSig, { answer: 'yes', ts: ans.ts, nonce: ans.nonce, sig: ans.sig });
    assert.equal(v.stages.understanding.firstRequest, true);

    // the phone can rebuild answerString from the update and verify with the friend's key
    const rebuilt = answerString({ requestId: v.requestId, checkerId: v.checkerId, claimedId: v.claimedId, amountCents: 2000,
      method: v.stages.information.method, answer: 'yes', ts: ans.ts, nonce: ans.nonce });
    assert.equal(crypto.verify('sha256', Buffer.from(rebuilt), { key: claimed.sign.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(ans.sig, 'base64')), true);

    assert.equal((await request(checker, claimed)).res.ok, true);
    const second = await update(checker, { requestId: (await request(checker, claimed)).requestId });
    assert.equal(second.stages.understanding.firstRequest, false);
  } finally { await t.stop(); }
});

test('Not me -> red, and every friend of the claimed person gets the alert', async () => {
  const t = await startServer();
  try {
    const { checker, claimed, other } = await trio(t);
    const rq = await request(checker, claimed);
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'not_me'));
    const v = await update(checker, rq, (x) => x.verdict === 'red');
    assert.equal(v.stages.confidence.answer, 'not_me');
    for (const phone of [other, checker]) {
      const alert = await phone.waitFor('circle:alert');
      assert.deepEqual([alert.impersonatedName, alert.claimedId, alert.requestId], ['Shivaan', claimed.userId, rq.requestId]);
    }
    assert.ok(!claimed.events.some((e) => e.ev === 'circle:alert'));
  } finally { await t.stop(); }
});

test('answers are rejected: forged, wrong key, wrong person, stale, replayed, edited details', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);

    const forged = claimed.signAnswer(rq, 'yes');
    forged.answer = 'not_me';
    assert.equal((await claimed.call('verify:answer', forged)).error, 'BAD_SIGNATURE');
    assert.equal((await claimed.call('verify:answer', checker.signAnswer(rq, 'yes'))).error, 'BAD_SIGNATURE');
    assert.equal((await checker.call('verify:answer', checker.signAnswer(rq, 'yes'))).error, 'NOT_ALLOWED');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes', { ts: Date.now() - 6 * 60 * 1000 }))).error, 'BAD_INPUT');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes', { nonce: 'short' }))).error, 'BAD_INPUT');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer({ ...rq, requestId: 'a'.repeat(32) }, 'yes'))).error, 'NOT_FOUND');
    // signed over a different amount than the request really has
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer({ ...rq, amountCents: 100 }, 'yes'))).error, 'BAD_SIGNATURE');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer({ ...rq, method: 'wire' }, 'yes'))).error, 'BAD_SIGNATURE');

    const good = claimed.signAnswer(rq, 'yes');
    assert.equal((await claimed.call('verify:answer', good)).ok, true);
    assert.equal((await claimed.call('verify:answer', good)).error, 'ALREADY_ANSWERED');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(rq, 'not_me'))).error, 'ALREADY_ANSWERED');

    const other = await request(checker, claimed);
    assert.equal((await claimed.call('verify:answer', { ...good, requestId: other.requestId })).error, 'BAD_SIGNATURE');
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(other, 'yes', { nonce: good.nonce }))).error, 'BAD_INPUT'); // nonce reuse
  } finally { await t.stop(); }
});

test('no answer -> amber "timeout" after 2 minutes (shortened), and a late answer is refused', async () => {
  const t = await startServer({ timeoutMs: 300, sweepMs: 50 });
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);
    const v = await update(checker, rq, (x) => x.stages.confidence.answer === 'timeout');
    assert.equal(v.verdict, 'amber');
    assert.match(v.reasons.join(' '), /No reply/);
    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'))).error, 'NOT_ALLOWED');
  } finally { await t.stop(); }
});

test('gift card + Yes stays amber', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed, { method: 'gift_card', text: 'buy me an apple gift card' });
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
    const v = await update(checker, rq, (x) => x.stages.confidence.answer === 'yes');
    assert.equal(v.verdict, 'amber');
    assert.equal(v.stages.understanding.paymentRisk, 'high');
  } finally { await t.stop(); }
});

test('tier boundaries: 2499 is tier 1, 2500 and 20000 are tier 2, 20001 is tier 3', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const tiers = [];
    for (const amountCents of [2499, 2500, 20000, 20001]) {
      const rq = await request(checker, claimed, { amountCents });
      tiers.push((await claimed.waitFor('verify:prompt', (p) => p.requestId === rq.requestId)).tier);
    }
    assert.deepEqual(tiers, [1, 2, 2, 3]);
  } finally { await t.stop(); }
});

test('tier 2: retype required; amber after Yes until the checker confirms the word', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed, { amountCents: 6000 });
    assert.equal(rq.tier, 2);
    const wrong = claimed.signAnswer(rq, 'yes');
    wrong.retypedCents = 600;
    assert.equal((await claimed.call('verify:answer', wrong)).error, 'AMOUNT_MISMATCH');
    delete wrong.retypedCents;
    assert.equal((await claimed.call('verify:answer', wrong)).error, 'AMOUNT_MISMATCH');

    assert.equal((await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'))).ok, true);
    const amber = await update(checker, rq, (x) => x.stages.confidence.answer === 'yes');
    assert.equal(amber.verdict, 'amber');
    assert.equal(amber.needs.word, true);
    assert.match(amber.reasons.join(' '), /ask them for your word/);

    assert.equal((await claimed.call('verify:wordcheck', { requestId: rq.requestId, passed: true })).error, 'NOT_ALLOWED');
    assert.equal((await checker.call('verify:wordcheck', { requestId: rq.requestId, passed: false })).error, 'BAD_INPUT');
    assert.equal((await checker.call('verify:wordcheck', { requestId: rq.requestId, passed: true })).ok, true);
    const green = await update(checker, rq, (x) => x.verdict === 'green');
    assert.equal(green.stages.confidence.wordOk, true);
  } finally { await t.stop(); }
});

test('tier 3: needs the word AND a second member; a No turns it red and alerts friends', async () => {
  const t = await startServer();
  try {
    for (const secondSays of ['yes', 'no']) {
      const { checker, claimed, other } = await trio(t);
      const rq = await request(checker, claimed, { amountCents: 30000 });
      assert.equal(rq.tier, 3);
      await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
      const prompt = await other.waitFor('verify:confirm_prompt');
      assert.deepEqual(prompt, { requestId: rq.requestId, claimedId: claimed.userId, checkerName: 'Sayan', claimedName: 'Shivaan', amountCents: 30000, method: 'venmo_cashapp_zelle' });
      await checker.call('verify:wordcheck', { requestId: rq.requestId, passed: true });
      const mid = await update(checker, rq, (x) => x.stages.confidence.wordOk);
      assert.equal(mid.verdict, 'amber');
      assert.equal(mid.stages.confidence.approvals.needed, 2);

      assert.equal((await checker.call('verify:confirm', checker.signConfirm(rq, 'yes'))).error, 'NOT_ALLOWED');
      assert.equal((await other.call('verify:confirm', { ...other.signConfirm(rq, 'yes'), answer: 'no' })).error, 'BAD_SIGNATURE');
      assert.equal((await other.call('verify:confirm', other.signConfirm(rq, secondSays))).ok, true);
      assert.equal((await other.call('verify:confirm', other.signConfirm(rq, secondSays))).error, 'ALREADY_ANSWERED');
      const v = await update(checker, rq, (x) => x.verdict !== 'amber');
      assert.equal(v.verdict, secondSays === 'yes' ? 'green' : 'red');
      if (secondSays === 'yes') assert.equal(v.stages.confidence.approvals.received, 2);
      else assert.equal((await checker.waitFor('circle:alert', (a) => a.requestId === rq.requestId)).impersonatedName, 'Shivaan');
    }
  } finally { await t.stop(); }
});

test('tier 3 when the claimed person has no other friend stays amber and says why', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed, { amountCents: 50000 });
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
    await checker.call('verify:wordcheck', { requestId: rq.requestId, passed: true });
    const v = await update(checker, rq, (x) => x.stages.confidence.wordOk);
    assert.equal(v.verdict, 'amber');
    assert.match(v.reasons.join(' '), /Add a third member to your circle/);
  } finally { await t.stop(); }
});

test('request input checks and rate limit', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const stranger = await t.phone('Stranger');
    const bad = async (over) => (await request(checker, claimed, over)).res.error;
    assert.equal(await bad({ amountCents: 0 }), 'BAD_INPUT');
    assert.equal(await bad({ amountCents: 12.5 }), 'BAD_INPUT');
    assert.equal(await bad({ method: 'paypal' }), 'BAD_INPUT');
    assert.equal(await bad({ channel: 'pigeon' }), 'BAD_INPUT');
    assert.equal(await bad({ text: 'x'.repeat(2001) }), 'BAD_INPUT');
    assert.equal(await bad({ imageDataUrl: 'data:text/html;base64,AAAA' }), 'BAD_INPUT');
    assert.equal(await bad({ imageDataUrl: `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}` }), 'BAD_INPUT');
    assert.equal(await bad({ claimedId: 'not-an-id' }), 'BAD_INPUT');
    assert.equal(await bad({ claimedId: stranger.userId }), 'NOT_PAIRED');
    assert.equal(await bad({ claimedId: checker.userId }), 'NOT_PAIRED');
    for (let i = 0; i < 5; i++) assert.equal((await request(checker, claimed)).res.ok, true);
    assert.equal(await bad({}), 'RATE_LIMITED');
  } finally { await t.stop(); }
});

test('message text and images are never stored; only a hash of the normalized text', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const secret = 'ZEBRA-SECRET-PHRASE-4821';
    const rq = await request(checker, claimed, { text: `Venmo   me ${secret}`, imageDataUrl: `data:image/png;base64,${Buffer.from(secret).toString('base64')}` });
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
    await update(checker, rq, (x) => x.stages.confidence.answer === 'yes');
    const dump = JSON.stringify(Object.fromEntries(
      t.server.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(({ name }) => [name, t.server.db.prepare(`SELECT * FROM ${name}`).all()]),
    ));
    assert.ok(!dump.toLowerCase().includes(secret.toLowerCase()));
    assert.ok(!dump.includes(Buffer.from(secret).toString('base64')));
    const row = t.server.db.prepare('SELECT text_hash FROM verify_requests WHERE request_id = ?').get(rq.requestId);
    const want = crypto.createHash('sha256').update(`venmo me ${secret.toLowerCase()}`).digest('hex');
    assert.equal(row.text_hash, want);
  } finally { await t.stop(); }
});

test('a reconnecting phone logs in again and gets its pending prompt and updates', async () => {
  const t = await startServer();
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);
    await claimed.waitFor('verify:prompt');
    const back = await t.phone('Shivaan 2', { register: false });
    back.sign = claimed.sign; back.exch = claimed.exch; back.userId = claimed.userId;
    await back.ready();
    assert.equal((await back.login()).ok, true);
    assert.equal((await back.waitFor('verify:prompt')).requestId, rq.requestId);

    const back2 = await t.phone('Sayan 2', { register: false });
    back2.sign = checker.sign; back2.exch = checker.exch; back2.userId = checker.userId;
    await back2.ready();
    await back2.login();
    assert.equal((await back2.waitFor('verify:update')).requestId, rq.requestId);
  } finally { await t.stop(); }
});

test('AI/analyze failures, garbage and slow output do not break the flow', async () => {
  const bad = [
    () => { throw new Error('boom'); },
    () => new Promise(() => {}),
    () => ({ tags: ['NOT_A_TAG', 'URGENCY'], paymentRisk: 'weird', explanation: 'x'.repeat(500), verdict: 'green', extra: 1 }),
  ];
  for (const analyze of bad) {
    const t = await startServer({ analyze });
    try {
      const { checker, claimed } = await trio(t, { third: false });
      const rq = await request(checker, claimed);
      await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
      const v = await update(checker, rq, (x) => x.verdict === 'green');
      assert.ok(v.stages.understanding.tags.every((tag) => ['URGENCY', 'FIRST_REQUEST'].includes(tag)));
      assert.ok(v.stages.understanding.explanation.length <= 140);
    } finally { await t.stop(); }
  }
});

test('AI tags can warn but cannot clear: a risky request with all tags still needs the person', async () => {
  const t = await startServer({ analyze: () => ({ tags: ['URGENCY', 'SECRECY', 'GIFT_CARD'], paymentRisk: 'high', explanation: 'looks like a scam', source: 'gemini' }) });
  try {
    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);
    const v = await update(checker, rq, (x) => x.stages.understanding.source !== 'x' && x.stages.understanding.tags.includes('URGENCY'));
    assert.equal(v.verdict, 'amber');
    assert.equal(v.stages.understanding.explanation, 'looks like a scam');
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'yes'));
    assert.equal((await update(checker, rq, (x) => x.stages.confidence.answer === 'yes')).verdict, 'amber');
  } finally { await t.stop(); }
});

test('demo reset: disabled without a key, guarded by it, soft keeps friends, hard wipes', async () => {
  const off = await startServer();
  try { assert.equal((await fetch(`${off.url}/demo`)).status, 404); } finally { await off.stop(); }

  const t = await startServer({ demoKey: 'sekrit-demo-key' });
  try {
    const post = (path, key) => fetch(`${t.url}${path}`, { method: 'POST', headers: key ? { 'x-demo-key': key } : {} });
    assert.equal((await post('/demo/reset')).status, 403);
    assert.equal((await post('/demo/reset', 'wrong-key-value')).status, 403);
    assert.equal((await fetch(`${t.url}/demo`)).status, 200);

    const { checker, claimed } = await trio(t, { third: false });
    const rq = await request(checker, claimed);
    assert.equal((await update(checker, rq)).stages.understanding.firstRequest, true);
    await claimed.call('verify:answer', claimed.signAnswer(rq, 'not_me'));

    assert.equal((await post('/demo/reset', 'sekrit-demo-key')).status, 200);
    assert.equal((await checker.waitFor('demo:reset')).hard, false);
    const status = await (await fetch(`${t.url}/demo/status`, { headers: { 'x-demo-key': 'sekrit-demo-key' } })).json();
    assert.equal(status.pairs, 1);
    assert.equal(status.users.length, 2);
    assert.equal(status.openRequests, 0);
    const again = await request(checker, claimed);
    assert.equal(again.res.ok, true);
    assert.equal((await update(checker, again)).stages.understanding.firstRequest, true);

    assert.equal((await post('/demo/reset?hard=1', 'sekrit-demo-key')).status, 200);
    assert.equal((await checker.call('circle:list', {})).friends.length, 0);
    assert.equal((await checker.call('verify:request', { claimedId: claimed.userId, amountCents: 100, method: 'other', channel: 'text' })).error, 'NOT_PAIRED');
  } finally { await t.stop(); }
});

test('abuse limits: registration per address, pairing codes per user; security headers set', async () => {
  const t = await startServer({ registerPerMin: 3 });
  try {
    const phones = [];
    for (let i = 0; i < 3; i++) phones.push(await t.phone(`P${i}`));
    const extra = await t.phone('Extra', { register: false });
    await extra.ready();
    assert.equal((await extra.register()).error, 'RATE_LIMITED');

    let last;
    for (let i = 0; i < 21; i++) last = await phones[0].call('pair:offer', {});
    assert.equal(last.error, 'RATE_LIMITED');

    const res = await fetch(`${t.url}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally { await t.stop(); }
});
