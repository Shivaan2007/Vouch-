// The call engine, tried on transcripts: scams that must stop, genuine calls that must not, and the ways people dodge keyword
// matching (spaced letters, mis-heard words, scripts told slowly). Each transcript is fed one sentence at a time with timestamps,
// the way a live call arrives, and the level after the last sentence is checked. No accuracy percentage is claimed from these:
// they are the cases we thought of, and the ones the next person finds go in here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callInit, callStep, callWhy } from '../js/lib/scan.js';

// Feed sentences with `gap` ms between them. After each one the engine is asked again 2 s later, as live speech keeps arriving.
function play(sentences, gap = 4000) {
  const st = callInit(); let said = ''; let now = 1_000_000;
  for (const s of sentences) {
    said = `${said} ${s}`.trim();
    callStep(st, said, now);
    callStep(st, said, now + 2000);
    now += gap;
  }
  return st;
}

const CASES = [
  // [name, sentences, min level, max level]
  ['dentist confirming an appointment', ["Hi it's Dr Lee's office confirming your appointment Tuesday.", 'Please confirm your date of birth.'], 1, 1],
  ['a real bank that says it will never ask for a PIN', ['This is Chase, we saw a charge on your card.', 'We will never ask for your PIN.', 'Please call the number on the back of your card.'], 0, 1],
  ['parcel arriving', ['Your parcel is arriving tomorrow between 2 and 4.'], 0, 0],
  ['mum lending forty', ["Mum can you lend me 40 for petrol, I'll pay you back."], 1, 1],
  ['reads back a code', ['We sent you a code, please read it back to me to verify.'], 2, 2],
  ['safe account', ['Your account is compromised.', 'We need to move your savings to a safe account.'], 2, 2],
  ['remote access', ['Download AnyDesk so I can fix your computer.'], 2, 2],
  ['officer plus gift cards', ["This is officer Grant, there's a warrant for you.", 'Pay with Apple gift cards.'], 2, 2],
  ['jailed grandchild with a courier', ["Grandma it's me, I'm in jail.", "Don't tell mom.", 'A courier will collect the cash.'], 2, 2],
  ['medicare script told in stages', ['Hello, calling from Medicare.', "What's your social security number?", 'Please stay on the line.'], 2, 2],
  ['do not use the number you trust', ["Don't call the number on your card.", 'Call us back on 800 555 0199.'], 1, 2],
  ['spelled-out OTP', ['Just read me the o t p.'], 2, 2],
  ['mis-heard gift cards', ['Go and buy some gif cards from the store.'], 2, 2],
  ['digits we texted', ['The six digits we texted, what are they?'], 2, 2],
  ['automated "never share this code"', ['Your code is 482913.', 'Never share this code with anyone.'], 0, 0],
  ['teller coaching', ["If the teller asks, say it's for a renovation."], 1, 2],
  ['fraud-check press 1', ['Did you make a $300 purchase at Walmart?', 'Press 1 to confirm.'], 0, 1],
  ['"urgent" said five times, minutes apart', ['Urgent!', 'Urgent!', 'Urgent!', 'Urgent!', 'Urgent!'], 0, 1],
  ['the user talking on a call', ["I'm on the line with the bank, hold on."], 0, 0],
];
for (const [name, lines, min, max] of CASES) {
  test(`call engine: ${name}`, () => {
    const gap = name.includes('minutes apart') ? 180000 : 4000;
    const st = play(lines, gap);
    assert.ok(st.level >= min && st.level <= max, `level ${st.level}, wanted ${min}..${max}`);
  });
}

test('a script told very slowly is still a script: the stages are remembered', () => {
  const st = play(["Hello, calling from Medicare.", "What's your social security number?", 'Please stay on the line.'], 600000);
  assert.equal(st.level, 2);
});

test('one mis-heard word does not make a STOP: soft signals must hold before they promote', () => {
  const st = callInit();
  const said = "This is officer Grant. We need your social security number. Don't tell anyone.";
  callStep(st, said, 1_000_000);
  assert.ok(st.level <= 1, 'not yet: a moment to hold');
  callStep(st, said, 1_002_000);
  assert.equal(st.level, 2, 'and then it is');
});

test('a red line is a stop at once, with no waiting', () => {
  const st = callInit();
  callStep(st, 'Please read me the code we just sent.', 5);
  assert.equal(st.level, 2);
});

test('a warning is never taken back during a call, even when the talk turns innocent', () => {
  const st = play(['Please read me the code we just sent.', 'Anyway, lovely weather today.', 'Nothing else to say.']);
  assert.equal(st.level, 2);
});

test('the same words fed again and again are not counted twice', () => {
  const st = callInit();
  for (let i = 0; i < 20; i++) callStep(st, 'We will never ask. Your date of birth please.', 1_000_000 + i * 1000);
  assert.ok(st.hits.filter((h) => h.cat === 'CREDENTIAL').length === 1);
});

test('the person is shown why, in plain words, as a ladder plus the top reasons and one thing to do', () => {
  const st = play(["Hello, calling from your bank.", 'Your account has been compromised.', "Don't tell anyone.", 'Please read me the code we texted you.']);
  const why = callWhy(st);
  assert.deepEqual(why.steps.map((s) => s.on), [true, true, true, true]);
  assert.equal(why.reasons.length, 3);
  assert.match(why.reasons[0], /read out a code/);
  assert.match(why.action, /Hang up/);
  assert.equal(callWhy(callInit()).action, '', 'nothing to say about a quiet call');
});

test('a story with no scam words and no code words scores nothing on the rules: it takes the AI read to catch it', () => {
  const said = "Hi Grandma, it's me. My phone broke so I'm calling from a friend's and I've had a really rough night.";
  const st = callInit();
  callStep(st, said, 1_000_000); callStep(st, said, 1_003_000);
  assert.equal(st.level, 0, 'the offline engine alone is not enough here, by design: it needs the AI read');
});