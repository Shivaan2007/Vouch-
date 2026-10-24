import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, pair, request } from './helpers.js';

const verdictOf = (phone, requestId, test) => phone.waitFor('verify:verdict', (v) => v.requestId === requestId && (!test || test(v)));

test('register, pair, and exchange public keys', async () => {
  const t = await startServer();
  try {
    const [a, b] = [await t.phone('Shivaan'), await t.phone('Sayan')];
    assert.equal((await a.register()).ok, true);
    const { token, expiresAt } = await a.call('pair:start', { userId: a.userId });
    assert.ok(token.length >= 8 && expiresAt > Date.now());

    const res = await b.call('pair:complete', { token, ...b.keys });
    assert.equal(res.ok, true);
    const doneA = await a.waitFor('pair:done');
    const doneB = await b.waitFor('pair:done');
    assert.equal(doneA.peer.signPub, b.signPub);
    assert.equal(doneA.peer.ecdhPub, b.ecdhPub);
    assert.equal(doneB.peer.signPub, a.signPub);
    assert.equal(doneA.pairId, doneB.pairId);

    const list = await a.call('circle:list');
    assert.deepEqual(list.friends.map((f) => f.name), ['Sayan']);
  } finally { await t.stop(); }
});

test('pair tokens are single use and expire', async () => {
  const t = await startServer();
  try {
    const [a, b, c] = [await t.phone('A'), await t.phone('B'), await t.phone('C')];
    await a.register();
    const { token } = await a.call('pair:start', { userId: a.userId });
    assert.equal((await b.call('pair:complete', { token, ...b.keys })).ok, true);
    assert.equal((await c.call('pair:complete', { token, ...c.keys })).error, 'token_used');
    assert.equal((await c.call('pair:complete', { token: 'NOPE1234', ...c.keys })).error, 'bad_token');
    assert.equal((await a.call('pair:complete', { token, ...a.keys })).ok === false, true);

    const old = await a.call('pair:start', { userId: a.userId });
    t.server.db.prepare('UPDATE pair_tokens SET expires_at = ? WHERE token = ?').run(Date.now() - 1, old.token);
    const d = await t.phone('D');
    assert.equal((await d.call('pair:complete', { token: old.token, ...d.keys })).error, 'token_expired');
  } finally { await t.stop(); }
});

test('login needs a signed challenge; unknown users must re-register', async () => {
  const t = await startServer();
  try {
    const a = await t.phone('A');
    await a.register();
    const evil = await t.phone('Evil');
    const ch = await evil.call('auth:challenge', { userId: a.userId });
    // Evil does not hold A's key, so signing with its own key must fail.
    const bad = await evil.call('auth:login', { userId: a.userId, challenge: ch.challenge, sig: evil.signMsg(`login|${a.userId}|${ch.challenge}`) });
    assert.equal(bad.error, 'bad_signature');

    const a2 = await t.phone('A again');
    a2.userId = a.userId; a2.sign = a.sign; a2.ecdh = a.ecdh;
    const c2 = await a2.call('auth:challenge', { userId: a.userId });
    const ok = await a2.call('auth:login', { userId: a.userId, challenge: c2.challenge, sig: a2.signMsg(`login|${a.userId}|${c2.challenge}`) });
    assert.equal(ok.ok, true);
    // the challenge cannot be reused
    assert.equal((await a2.call('auth:login', { userId: a.userId, challenge: c2.challenge, sig: a2.signMsg(`login|${a.userId}|${c2.challenge}`) })).ok, false);
    assert.equal((await evil.call('auth:challenge', { userId: 'nobody-here-123' })).error, 'unknown_user');
  } finally { await t.stop(); }
});

test('tier 1 Yes -> green with a signature the requester can re-check', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId, res } = await request(req, friend);
    assert.equal(res.ok, true);
    assert.equal(res.tier, 1);
    assert.equal(res.firstRequest, true);

    const prompt = await friend.waitFor('verify:prompt');
    assert.equal(prompt.fromName, 'Sayan');
    assert.equal(prompt.amount, 20);

    const waiting = await verdictOf(req, requestId);
    assert.equal(waiting.verdict, 'amber');

    const ans = friend.signAnswer(requestId, 'yes');
    assert.equal((await friend.call('verify:answer', ans)).ok, true);
    const v = await verdictOf(req, requestId, (x) => x.verdict === 'green');
    assert.equal(v.stages.information.claimedName, 'Shivaan');
    assert.equal(v.stages.confidence.answer, 'yes');
    assert.equal(v.stages.confidence.approvals.received, 1);
    assert.equal(v.stages.confidence.answerSig.sig, ans.sig);
    // a second request between the same two is not a "first request"
    assert.equal((await request(req, friend)).res.firstRequest, false);
  } finally { await t.stop(); }
});

test('Not me -> red, and every circle member gets the alert', async () => {
  const t = await startServer();
  try {
    const [req, friend, third] = [await t.phone('Sayan'), await t.phone('Shivaan'), await t.phone('Tejasv')];
    await pair(friend, req);
    await pair(friend, third);
    const { requestId } = await request(req, friend);
    await friend.call('verify:answer', friend.signAnswer(requestId, 'not_me'));
    const v = await verdictOf(req, requestId, (x) => x.verdict === 'red');
    assert.equal(v.stages.confidence.answer, 'not_me');
    const alert = await third.waitFor('circle:alert');
    assert.equal(alert.impersonatedName, 'Shivaan');
    assert.equal(alert.requestId, requestId);
    await req.waitFor('circle:alert');
  } finally { await t.stop(); }
});

test('answers are rejected: bad signature, wrong user, replay, stale, duplicate', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId } = await request(req, friend);

    const forged = friend.signAnswer(requestId, 'yes');
    forged.answer = 'not_me';            // signature no longer matches
    assert.equal((await friend.call('verify:answer', forged)).error, 'bad_signature');
    assert.equal((await friend.call('verify:answer', req.signAnswer(requestId, 'yes'))).error, 'bad_signature'); // signed by the wrong key
    assert.equal((await req.call('verify:answer', req.signAnswer(requestId, 'yes'))).error, 'forbidden');        // not the claimed user
    assert.equal((await friend.call('verify:answer', friend.signAnswer(requestId, 'yes', { ts: Date.now() - 6 * 60 * 1000 }))).error, 'stale_timestamp');
    assert.equal((await friend.call('verify:answer', friend.signAnswer('nonexistent-req', 'yes'))).error, 'unknown_request');

    const good = friend.signAnswer(requestId, 'yes');
    assert.equal((await friend.call('verify:answer', good)).ok, true);
    assert.equal((await friend.call('verify:answer', good)).error, 'already_answered');

    const other = (await request(req, friend)).requestId;
    const replay = { ...good, requestId: other };          // old signature on another request
    assert.equal((await friend.call('verify:answer', replay)).error, 'bad_signature');
    const sameNonce = friend.signAnswer(other, 'yes', { nonce: good.nonce });
    assert.equal((await friend.call('verify:answer', sameNonce)).error, 'replay');
  } finally { await t.stop(); }
});

test('no answer -> amber after the timeout, and a late answer is refused', async () => {
  const t = await startServer({ timeoutMs: 300, sweepMs: 50 });
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId } = await request(req, friend);
    const v = await verdictOf(req, requestId, (x) => x.reasons.join(' ').includes('No answer'));
    assert.equal(v.verdict, 'amber');
    assert.equal((await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'))).error, 'expired');
  } finally { await t.stop(); }
});

test('gift card + Yes stays amber', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId } = await request(req, friend, { paymentMethod: 'gift_card', text: 'buy me an apple gift card' });
    await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
    const v = await verdictOf(req, requestId, (x) => x.stages.confidence.answer === 'yes');
    assert.equal(v.verdict, 'amber');
    assert.equal(v.stages.understanding.paymentRisk, 'high');
  } finally { await t.stop(); }
});

test('tier 2: amber after Yes until the requester confirms the word', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId, res } = await request(req, friend, { amount: 60 });
    assert.equal(res.tier, 2);
    await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
    const amber = await verdictOf(req, requestId, (x) => x.stages.confidence.answer === 'yes');
    assert.equal(amber.verdict, 'amber');
    assert.equal(amber.needs.word, true);
    assert.match(amber.reasons.join(' '), /ask them for your word/);

    assert.equal((await friend.call('verify:word', { requestId, ok: true })).error, 'forbidden'); // only the requester
    assert.equal((await req.call('verify:word', { requestId, ok: false })).error, 'bad_word_flag');
    assert.equal((await req.call('verify:word', { requestId, ok: true })).ok, true);
    const green = await verdictOf(req, requestId, (x) => x.verdict === 'green');
    assert.equal(green.stages.confidence.wordOk, true);
  } finally { await t.stop(); }
});

test('tier 3: needs the word AND a second member; a No turns it red', async () => {
  const t = await startServer();
  try {
    for (const secondSays of ['yes', 'no']) {
      const [req, friend, second] = [await t.phone('Sayan'), await t.phone('Shivaan'), await t.phone('Tejasv')];
      await pair(friend, req);
      await pair(friend, second);
      const { requestId, res } = await request(req, friend, { amount: 300 });
      assert.equal(res.tier, 3);
      await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
      const prompt = await second.waitFor('verify:confirm_prompt');
      assert.equal(prompt.claimedName, 'Shivaan');
      assert.equal(prompt.fromName, 'Sayan');
      await req.call('verify:word', { requestId, ok: true });
      const mid = await verdictOf(req, requestId, (x) => x.stages.confidence.wordOk);
      assert.equal(mid.verdict, 'amber');
      assert.equal(mid.stages.confidence.approvals.needed, 2);

      assert.equal((await req.call('verify:confirm', req.signAnswer(requestId, 'yes'))).error, 'forbidden');
      assert.equal((await second.call('verify:confirm', second.signAnswer(requestId, secondSays))).ok, true);
      const v = await verdictOf(req, requestId, (x) => x.verdict !== 'amber');
      assert.equal(v.verdict, secondSays === 'yes' ? 'green' : 'red');
      if (secondSays === 'yes') assert.equal(v.stages.confidence.approvals.received, 2);
    }
  } finally { await t.stop(); }
});

test('tier 3 with only two people in the circle stays amber and says why', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId } = await request(req, friend, { amount: 500 });
    await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
    await req.call('verify:word', { requestId, ok: true });
    const v = await verdictOf(req, requestId, (x) => x.stages.confidence.wordOk);
    assert.equal(v.verdict, 'amber');
    assert.match(v.reasons.join(' '), /third member/);
  } finally { await t.stop(); }
});

test('input checks and rate limit', async () => {
  const t = await startServer();
  try {
    const [req, friend, stranger] = [await t.phone('Sayan'), await t.phone('Shivaan'), await t.phone('Stranger')];
    await pair(friend, req);
    await stranger.register();
    assert.equal((await request(req, friend, { amount: -5 })).res.error, 'bad_amount');
    assert.equal((await request(req, friend, { paymentMethod: 'paypal' })).res.error, 'bad_payment_method');
    assert.equal((await request(req, stranger)).res.error, 'not_paired');
    assert.equal((await request(req, req)).res.error, 'cannot_verify_self');
    assert.equal((await request(req, friend, { imageBase64: 'A'.repeat(5.8 * 1024 * 1024) })).res.error, 'image_too_large');
    const dup = (await request(req, friend)).requestId;
    assert.equal((await request(req, friend, { requestId: dup })).res.error, 'duplicate_request');
    for (let i = 0; i < 2; i++) assert.equal((await request(req, friend)).res.ok, true);
    for (let i = 0; i < 2; i++) assert.equal((await request(req, friend)).res.ok, true); // 5 valid requests so far
    assert.equal((await request(req, friend)).res.error, 'rate_limited');
  } finally { await t.stop(); }
});

test('message text and images are never stored', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const secret = 'ZEBRA-SECRET-PHRASE-4821';
    const { requestId } = await request(req, friend, { text: `venmo me ${secret}`, imageBase64: Buffer.from(secret).toString('base64') });
    await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
    await verdictOf(req, requestId, (x) => x.stages.confidence.answer === 'yes');
    const dump = JSON.stringify(Object.fromEntries(
      t.server.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(({ name }) => [name, t.server.db.prepare(`SELECT * FROM ${name}`).all()]),
    ));
    assert.ok(!dump.includes(secret));
    assert.ok(!dump.includes(Buffer.from(secret).toString('base64')));
    const row = t.server.db.prepare('SELECT text_hash FROM verify_requests WHERE request_id = ?').get(requestId);
    assert.match(row.text_hash, /^[0-9a-f]{64}$/);
  } finally { await t.stop(); }
});

test('a reconnecting phone gets its pending prompt again', async () => {
  const t = await startServer();
  try {
    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId } = await request(req, friend);
    await friend.waitFor('verify:prompt');
    const back = await t.phone('Shivaan reconnect');
    back.userId = friend.userId; back.sign = friend.sign; back.ecdh = friend.ecdh;
    const { challenge } = await back.call('auth:challenge', { userId: friend.userId });
    await back.call('auth:login', { userId: friend.userId, challenge, sig: back.signMsg(`login|${friend.userId}|${challenge}`) });
    const prompt = await back.waitFor('verify:prompt');
    assert.equal(prompt.requestId, requestId);
  } finally { await t.stop(); }
});

test('Gemini/analyze failures do not break the flow', async () => {
  for (const analyze of [() => { throw new Error('boom'); }, () => new Promise(() => {}), () => ({ tags: ['NOT_A_TAG', 'URGENCY'], paymentRisk: 'weird', explanation: 'x'.repeat(500), extra: 1 })]) {
    const t = await startServer({ analyze });
    try {
      const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
      await pair(friend, req);
      const { requestId } = await request(req, friend);
      await friend.call('verify:answer', friend.signAnswer(requestId, 'yes'));
      const v = await verdictOf(req, requestId, (x) => x.verdict === 'green');
      assert.ok(v.stages.understanding.tags.every((tag) => ['URGENCY', 'FIRST_REQUEST'].includes(tag)));
      assert.ok(v.stages.understanding.explanation.length <= 140);
    } finally { await t.stop(); }
  }
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

    const [req, friend] = [await t.phone('Sayan'), await t.phone('Shivaan')];
    await pair(friend, req);
    const { requestId, res } = await request(req, friend);
    assert.equal(res.firstRequest, true);
    await friend.call('verify:answer', friend.signAnswer(requestId, 'not_me'));

    assert.equal((await post('/demo/reset', 'sekrit-demo-key')).status, 200);
    assert.equal((await req.waitFor('demo:reset')).hard, false);
    const status = await (await fetch(`${t.url}/demo/status`, { headers: { 'x-demo-key': 'sekrit-demo-key' } })).json();
    assert.equal(status.pairs, 1);
    assert.equal(status.users.length, 2);
    assert.equal(status.openRequests, 0);
    const again = await request(req, friend);               // still paired, and a first request again
    assert.equal(again.res.ok, true);
    assert.equal(again.res.firstRequest, true);

    assert.equal((await post('/demo/reset?hard=1', 'sekrit-demo-key')).status, 200);
    assert.equal((await req.call('circle:list')).friends.length, 0);
    assert.equal((await req.call('auth:challenge', { userId: req.userId })).error, 'unknown_user');
  } finally { await t.stop(); }
});
