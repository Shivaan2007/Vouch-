import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectTags } from '../src/risk/rules.js';
import { TAG_LIST } from '../src/config.js';

// A second set of messages, written after the first fixtures, covering stories the first set did not: emergencies,
// borrowed phones, bank and account alerts, reimbursement lures. Server rules only (the phone-side hints have their own
// parity test on scams.json). Short generic paraphrases. Phishing, overpayment and "send rent to a new account" scams
// have no tag in the fixed list, so they are left to Gemini and to the friend's signed answer.
const set = JSON.parse(readFileSync(new URL('./fixtures/flagging.json', import.meta.url), 'utf8'));
const expected = (f) => TAG_LIST.filter((t) => f.expectTags.includes(t));

for (const [kind, list] of [['scam', set.scams], ['normal', set.normal]]) {
  for (const f of list) {
    test(`${kind}: ${f.text.slice(0, 60)}`, () => {
      assert.deepEqual(detectTags(f.text), expected(f));
    });
  }
}

test('an emergency story is only pressure when it also asks for money', () => {
  assert.deepEqual(detectTags('my brother is in the hospital, visiting hours are at 4'), []);
  assert.deepEqual(detectTags('my brother is in the hospital, can you send $200 for the bill'), ['URGENCY']);
  assert.deepEqual(detectTags('i was arrested last year, long story'), []);
});

test('plain talk about phones, accounts and refunds does not raise tags', () => {
  for (const t of ['I will refund you the deposit on friday', 'is your account set up for the app?',
    'we will reimburse you for the receipt', 'texting from my phone now']) {
    assert.ok(!detectTags(t).includes('URGENCY'), t);
    assert.ok(!detectTags(t).includes('NEW_NUMBER'), t);
  }
});
