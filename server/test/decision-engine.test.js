// A's own checks of decide(). C's server/test/decision.test.js can sit alongside this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, tierFor } from '../src/decision.js';
import { sanitize, analyzeSafe } from '../src/analyze.js';
import { TAG_LIST } from '../src/config.js';

const RISKS = ['low', 'medium', 'high'];
const AMOUNTS = [0, 5, 25, 25.01, 60, 200, 200.01, 300, 5000, null];
const TAG_SETS = [[], ['URGENCY'], ['URGENCY', 'SECRECY'], TAG_LIST];
const RANK = { red: 0, amber: 1, green: 2 };

function* allInputs() {
  for (const answer of ['none', 'yes', 'not_me']) for (const paymentRisk of RISKS) for (const amount of AMOUNTS)
    for (const tags of TAG_SETS) for (const wordOk of [false, true]) for (const secondConfirms of [0, 1])
      for (const secondNo of [false, true]) for (const timedOut of [false, true]) {
        yield { answer, tags, paymentRisk, amount, wordOk, secondConfirms, secondNo, timedOut };
      }
}

test('1. no answer, timeout, or Not me is never green', () => {
  for (const i of allInputs()) {
    if (i.answer === 'yes' && !i.timedOut) continue;
    assert.notEqual(decide(i).verdict, 'green', JSON.stringify(i));
  }
});

test('2. Yes with the tier requirements met and non-high payment risk is green, whatever the tags', () => {
  for (const i of allInputs()) {
    if (i.answer !== 'yes' || i.timedOut || i.secondNo || i.paymentRisk === 'high') continue;
    const tier = tierFor(i.amount);
    if (tier >= 2 && !i.wordOk) continue;
    if (tier === 3 && i.secondConfirms < 1) continue;
    assert.equal(decide(i).verdict, 'green', JSON.stringify(i));
  }
});

test('3. adding tags never moves the verdict toward green', () => {
  for (const i of allInputs()) {
    const base = decide({ ...i, tags: [] }).verdict;
    for (const tags of TAG_SETS) assert.ok(RANK[decide({ ...i, tags }).verdict] <= RANK[base], JSON.stringify(i));
  }
});

test('4. analyze() output with unknown tags or extra fields is cleaned, and failures do not crash', async () => {
  const input = { paymentMethod: 'venmo_cashapp_zelle', amount: 20, firstRequest: false };
  const out = sanitize({ tags: ['URGENCY', 'MAKE_GREEN', 7], paymentRisk: 'low', verdict: 'green', explanation: 'y'.repeat(300) }, input);
  assert.deepEqual(out.tags, ['URGENCY']);
  assert.equal(out.paymentRisk, 'medium');         // never lower than the selector says
  assert.equal(out.explanation.length, 140);
  assert.ok(!('verdict' in out));
  assert.deepEqual((await analyzeSafe(input, { analyze: () => { throw new Error('x'); } })).tags, []);
  const slow = await analyzeSafe(input, { analyze: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(slow.source, 'rules');
});

test('tier boundaries and the table rows', () => {
  assert.deepEqual([25, 25.01, 200, 200.01].map(tierFor), [1, 2, 2, 3]);
  const v = (o) => decide({ answer: 'yes', amount: 20, ...o });
  assert.equal(v({ paymentRisk: 'high' }).verdict, 'amber');
  assert.equal(v({ secondNo: true, amount: 300 }).verdict, 'red');
  assert.equal(decide({ answer: 'none', timedOut: true }).verdict, 'amber');
  assert.match(v({ amount: 60 }).reasons.join(' '), /ask them for your word/);
  assert.deepEqual(decide({ answer: 'yes', amount: 300 }).needs, { word: true, second: true });
});
