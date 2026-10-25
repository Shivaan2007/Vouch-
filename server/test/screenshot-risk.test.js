import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, pair, request } from './helpers.js';
import { analyze } from '../src/risk/index.js';

// A screenshot is the one input the phrase rules cannot read. If Gemini sees a gift-card request in it, a Yes from the
// friend must stay amber even when the person picked Venmo. If Gemini sees nothing about how to pay, a Yes is green.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const gemini = (tags) => async () => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tags, explanation: 'From the screenshot.' }) }] } }] }),
});

async function yesOnScreenshot(geminiTags) {
  const t = await startServer({ analyze: (input) => analyze(input, { apiKey: 'k', timeoutMs: 1000, fetchImpl: gemini(geminiTags) }) });
  try {
    const a = await t.phone('Checker'); const b = await t.phone('Friend');
    await pair(a, b);
    const rq = await request(a, b, { amountCents: 2000, method: 'venmo_cashapp_zelle', text: undefined, imageDataUrl: PNG });
    assert.ok(rq.res.ok, rq.res.error);
    const ans = await b.call('verify:answer', b.signAnswer(rq, 'yes'));
    assert.ok(ans.ok, ans.error);
    return await a.waitFor('verify:update', (p) => p.requestId === rq.requestId && p.stages.confidence.answer === 'yes');
  } finally { await t.stop(); }
}

test('Yes on a gift-card screenshot stays amber even though Venmo was selected', async () => {
  const u = await yesOnScreenshot(['GIFT_CARD', 'URGENCY']);
  assert.equal(u.verdict, 'amber');
  assert.equal(u.stages.understanding.paymentRisk, 'high');
  assert.ok(u.stages.understanding.tags.includes('GIFT_CARD'));
});

test('Yes on a screenshot with nothing about gift cards, wires or crypto is green', async () => {
  const u = await yesOnScreenshot(['URGENCY']);
  assert.equal(u.verdict, 'green');
  assert.equal(u.stages.understanding.paymentRisk, 'medium');
});

test('with Gemini down, a screenshot request behaves exactly like before (rules only)', async () => {
  const t = await startServer({ analyze: (input) => analyze(input, { apiKey: '' }) });
  try {
    const a = await t.phone('Checker'); const b = await t.phone('Friend');
    await pair(a, b);
    const rq = await request(a, b, { amountCents: 2000, method: 'venmo_cashapp_zelle', text: undefined, imageDataUrl: PNG });
    await b.call('verify:answer', b.signAnswer(rq, 'yes'));
    const u = await a.waitFor('verify:update', (p) => p.requestId === rq.requestId && p.stages.confidence.answer === 'yes');
    assert.equal(u.verdict, 'green'); // nothing could read the screenshot; the selector said Venmo
  } finally { await t.stop(); }
});
