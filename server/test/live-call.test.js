import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callInit, callStep, callWhy } from '../../web/js/lib/scan.js';

// The staged calls in docs/LIVE-CALL-DEMO.md, fed to the phone's call engine a line at a time, six seconds apart.
const BANK = [
  'Hello, this is the fraud department at First Harbor Bank. Am I speaking with Mr. Lee?',
  'We noticed a payment of four hundred and eighty dollars that you may not recognise. I would like to help you cancel it.',
  'To cancel it I just need the six digit code we texted you. Please read it to me.',
  'Please stay on the line. The payment goes through in two minutes.',
];
const CARD = [
  "Hi, I'm calling from your bank's security team about suspicious activity on your card.",
  "To verify it's you I need your full card number and the three digits on the back.",
  "Please don't hang up, we need to do this now.",
];
const SAFE = ['This is the fraud team. Your account has been compromised.', 'To protect your money you need to move your savings to a safe account that I will give you.'];
const GRANDCHILD = [
  "Grandma, it's me. I know this is a new number, my phone broke.",
  "I need two hundred dollars in Apple gift cards right now, please don't tell Mom.",
  "There's no time for the word, please hurry.",
];
const HARMLESS = [
  'Hello, this is First Harbor Bank confirming your appointment tomorrow at three.',
  'This is an appointment reminder. We will never ask for your PIN or your password.',
  'Press 1 to confirm or press 2 to cancel.',
];

function play(lines) {
  const st = callInit();
  let text = '';
  let now = 1e6;
  const levels = [];
  for (const l of lines) {
    text += ` ${l}`;
    now += 6000;
    callStep(st, text, now);
    levels.push(st.level);
  }
  callStep(st, text, now + 2000); // soft signals must hold for a moment before they become STOP
  levels.push(st.level);
  return { st, levels };
}

test('bank call: quiet at the introduction, STOP when the caller asks for the code, and says why', () => {
  const { st, levels } = play(BANK);
  assert.ok(levels[0] < 2, 'the introduction alone is not a STOP');
  assert.equal(levels[2], 2, 'STOP on the code request');
  assert.equal(levels.at(-1), 2, 'and it stays STOP');
  assert.match(callWhy(st).reasons[0], /read out a code/);
});

for (const [name, lines] of [['card details', CARD], ['safe account', SAFE], ['fake grandchild with gift cards', GRANDCHILD]]) {
  test(`staged scam call reaches STOP: ${name}`, () => {
    assert.equal(play(lines).levels.at(-1), 2);
  });
}

test('the harmless bank reminder call never warns', () => {
  const { levels } = play(HARMLESS);
  assert.deepEqual(levels.filter((l) => l > 0), []);
});
