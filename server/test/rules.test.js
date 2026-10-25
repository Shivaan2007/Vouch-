import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectTags, extractAmount, inferPaymentRisk, paymentRiskFor, analyzeRules } from '../src/risk/rules.js';
import { analyze } from '../src/risk/index.js';
import { TAG_LIST } from '../src/config.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scams.json', import.meta.url), 'utf8'));
const all = [...fixtures.scams.map((f) => ['scam', f]), ...fixtures.normal.map((f) => ['normal', f])];

for (const [kind, f] of all) {
  test(`${kind}: ${f.text.slice(0, 50)}`, () => {
    const out = analyzeRules({ text: f.text, paymentMethod: f.method, firstRequest: false });
    assert.deepEqual(out.tags, TAG_LIST.filter((t) => f.expectTags.includes(t)));
    assert.equal(out.paymentRisk, f.expectRisk);
    assert.equal(out.amount, f.expectAmount);
    assert.equal(out.source, 'rules');
    assert.ok(out.explanation.length > 0 && out.explanation.length <= 140);
  });
}

test('scam fixtures all get at least one warning tag; normal ones never get the scary ones', () => {
  for (const f of fixtures.scams) assert.ok(detectTags(f.text).length >= 1, f.text);
  for (const f of fixtures.normal) {
    for (const t of ['SECRECY', 'NEW_NUMBER', 'GIFT_CARD', 'WIRE', 'CRYPTO', 'URGENCY']) {
      assert.ok(!detectTags(f.text).includes(t), `${t} on: ${f.text}`);
    }
  }
});

test('FIRST_REQUEST comes only from the firstRequest flag', () => {
  assert.ok(detectTags('hey', { firstRequest: true }).includes('FIRST_REQUEST'));
  assert.ok(!detectTags('first time asking you for money', {}).includes('FIRST_REQUEST'));
  assert.ok(!detectTags('hey', { firstRequest: false }).includes('FIRST_REQUEST'));
});

test('tags come back in TAG_LIST order, deduplicated', () => {
  const tags = detectTags('urgent urgent asap wire wire bitcoin', { firstRequest: true });
  assert.deepEqual(tags, TAG_LIST.filter((t) => tags.includes(t)));
  assert.equal(new Set(tags).size, tags.length);
});

test('curly apostrophes and caps do not hide a detector', () => {
  assert.ok(detectTags('DON’T TELL anyone').includes('SECRECY'));
  assert.ok(detectTags('Send a Gift Card').includes('GIFT_CARD'));
});

test('extractAmount', () => {
  assert.equal(extractAmount('venmo me $60'), 60);
  assert.equal(extractAmount('$ 60.50 please'), 60.5);
  assert.equal(extractAmount('need $1,200.00 today'), 1200);
  assert.equal(extractAmount('send $2k'), 2000);
  assert.equal(extractAmount('40 dollars'), 40);
  assert.equal(extractAmount('20 bucks'), 20);
  assert.equal(extractAmount('first $5 then $500'), 5);
  assert.equal(extractAmount('see you at 7'), null);
  assert.equal(extractAmount(''), null);
  assert.equal(extractAmount(undefined), null);
});

test('payment risk: selector, inference, and the higher of the two', () => {
  assert.equal(paymentRiskFor('gift_card', ''), 'high');
  assert.equal(paymentRiskFor('wire', 'hi'), 'high');
  assert.equal(paymentRiskFor('crypto', 'hi'), 'high');
  assert.equal(paymentRiskFor('venmo_cashapp_zelle', 'hi'), 'medium');
  assert.equal(paymentRiskFor('cash_in_person', 'hi'), 'low');
  assert.equal(paymentRiskFor('other', 'hi'), 'low');
  assert.equal(paymentRiskFor('unknown', 'send me an itunes gift card'), 'high');
  assert.equal(paymentRiskFor('unknown', 'zelle me'), 'medium');
  assert.equal(paymentRiskFor('unknown', 'hi'), 'low');
  assert.equal(paymentRiskFor('cash_in_person', 'actually bitcoin'), 'high');   // text beats a low selector
  assert.equal(paymentRiskFor('gift_card', 'venmo is fine'), 'high');           // selector beats a lower text hint
  assert.equal(paymentRiskFor('not-a-method', 'hi'), 'low');
  for (const w of ['an apple gift card', 'steam cards', 'google play cards', 'bitcoin', 'cash app', 'venmo']) {
    assert.ok(inferPaymentRisk(`pay with ${w}`), w);
  }
  // Bare words in an ordinary sentence must not raise the risk (a Yes would turn amber for no reason).
  for (const t of ['can you pay me $40 to steam clean the couch', 'I am on google play', 'the wire in my lamp broke',
    'the target near me', 'apple pie tonight?']) {
    assert.equal(inferPaymentRisk(t), null, t);
    assert.ok(!detectTags(t).some((x) => ['GIFT_CARD', 'WIRE', 'CRYPTO'].includes(x)), t);
  }
  assert.equal(inferPaymentRisk('wire me the money'), 'high');
  assert.equal(inferPaymentRisk('send it by wire'), 'high');
});

test('analyze(): ignores bad input and never throws', async () => {
  for (const bad of [undefined, null, 5, 'str', [], {}, { text: 42 }, { text: null, amount: 'x' }, { text: 'x'.repeat(100000) }]) {
    const out = await analyze(bad);
    assert.ok(Array.isArray(out.tags));
    assert.ok(out.tags.every((t) => TAG_LIST.includes(t)));
    assert.ok(['low', 'medium', 'high'].includes(out.paymentRisk));
    assert.equal(out.source, 'rules');
    assert.ok(out.explanation.length <= 140);
  }
});

test('analyze(): ignores extra fields, honors a passed amount', async () => {
  const out = await analyze({ text: 'hi', amount: 75, claimedName: 'Sam', firstRequest: true, paymentMethod: 'wire', verdict: 'green', tags: ['MAKE_GREEN'] });
  assert.deepEqual(out.tags, ['FIRST_REQUEST']);
  assert.equal(out.amount, 75);
  assert.equal(out.paymentRisk, 'high');
  assert.equal('verdict' in out, false);
});
