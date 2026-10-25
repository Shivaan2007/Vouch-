import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, asksForMoney, riskyEnough, callRisk } from '../js/lib/scan.js';

const SCAM = "hey it's me, new number! I'm stuck at the store and my card got declined. Can you buy $200 in Apple gift cards right now? Please don't tell mom, I'll pay you back tonight.";

test('suggest reads the classic grandparent scam', () => {
  const s = suggest(SCAM);
  for (const t of ['GIFT_CARD', 'URGENCY', 'SECRECY', 'NEW_NUMBER', 'PAYBACK_PROMISE']) assert.ok(s.tags.includes(t), t);
  assert.equal(s.amount, '200');
  assert.equal(s.method, 'gift_card');
  assert.equal(s.ask, true);
  assert.equal(riskyEnough(s.tags), true);
});

test('asksForMoney catches stories nobody planned for', () => {
  for (const line of [
    "Grandma I'm in the hospital, I need $3,000 for the surgery today",
    'This is the IRS. You owe back taxes, you must pay the fee now',
    'Your landlord changed accounts, please send the deposit to this new one',
    'I got arrested, can you send bail money?',
    'i need you to wire 500 dollars',
  ]) assert.equal(asksForMoney(line), true, line);
});

test('asksForMoney leaves ordinary talk alone', () => {
  for (const line of [
    'how are you doing today', 'can you send me the photos from the trip', 'dinner is at 6, bring dessert',
    'I need to pick up the kids', 'happy birthday!',
  ]) assert.equal(asksForMoney(line), false, line);
});

test('single venmo ask is a money ask but not alarming on its own', () => {
  const s = suggest('can you venmo me $20 for lunch');
  assert.equal(s.ask, true);
  assert.equal(s.method, 'venmo_cashapp_zelle');
  assert.equal(riskyEnough(s.tags), false);
});

test('callRisk levels', () => {
  assert.equal(callRisk('hi grandma how are you').level, 0);
  assert.equal(callRisk('I need some money for the bus').level, 1);
  assert.equal(callRisk(SCAM).level, 2);
  assert.equal(callRisk('please buy gift cards').level, 2);
});

test('institution impostors are recognised and treated as a scam when they want money', () => {
  for (const line of [
    'This is the IRS. You owe back taxes and must pay the fee today',
    'Your bank fraud department detected a problem, verify your account',
    'Microsoft support: your computer has a virus, call us',
    'There is an arrest warrant in your name, pay the fine now',
    'Social Security suspended your number, buy gift cards to fix it',
  ]) assert.equal(suggest(line).institution, true, line);
  assert.equal(callRisk('This is the IRS, you owe back taxes, pay the fee now').level, 2);
  assert.equal(callRisk('Your bank fraud department needs you to buy gift cards').level, 2);
  for (const line of ['I called my bank today', 'the police were at the game', 'we ordered from amazon', 'can you send me the photos'])
    assert.equal(suggest(line).institution, false, line);
});

test('never throws on junk', () => {
  for (const v of [undefined, null, 42, {}, '', 'a'.repeat(100000)]) {
    assert.doesNotThrow(() => { suggest(v); callRisk(v); });
  }
});

import { classify } from '../js/lib/scan.js';

test('classify names the scam in plain words and gives steps', () => {
  const cases = [
    ['hey it\'s me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don\'t tell mom', 'family'],
    ['please buy 2 apple gift cards and send me the codes', 'giftcard'],
    ['This is the IRS. You owe back taxes, pay the fee now', 'institution'],
    ['Microsoft support: your computer has a virus, pay $200 to fix it', 'institution'],
    ['you won the lottery! pay a processing fee to claim your prize', 'prize'],
    ['we changed our bank details, wire the deposit to the new account', 'wire'],
    ['I need $50 for the bus right now, please', 'pressure'],
    ['can you venmo me $20 for lunch', 'ask'],
  ];
  for (const [text, id] of cases) assert.equal(classify(text)?.id, id, text);
  const c = classify('please buy gift cards');
  assert.ok(c.title && c.why && c.steps.length >= 2);
  for (const ordinary of ['dinner is at six', 'happy birthday!', 'can you send me the photos', '']) assert.equal(classify(ordinary), null, ordinary);
});

import { highlight } from '../js/lib/scan.js';

test('highlight marks the words that raised the alarm and keeps the text intact', () => {
  const text = "Grandma it's me, I got a new number. Please buy $200 in Apple gift cards right now, don't tell mom";
  const parts = highlight(text);
  assert.equal(parts.map((p) => p.text).join(''), text, 'nothing lost or reordered');
  const hits = parts.filter((p) => p.hit).map((p) => p.text.toLowerCase());
  for (const w of ['new number', '$200', 'gift cards', 'right now']) assert.ok(hits.some((h) => h.includes(w)), `marks "${w}"`);
  assert.deepEqual(highlight('dinner is at six'), [{ text: 'dinner is at six', hit: false }]);
  assert.deepEqual(highlight(''), []);
  assert.doesNotThrow(() => highlight(undefined));
});

test('real-world money asks are caught, and the amount is read however it is written', () => {
  const cases = [
    ['hey I need 1000 dollars', '1000'], ['bro i need $1000', '1000'], ['yo can you send me 1000', '1000'], ['need 1k asap', '1000'],
    ['can you lend me $1,000 until friday', '1000'], ['I need to borrow a thousand dollars', '1000'], ['hey can u venmo me 1000?', '1000'],
    ['I am short on rent, could you help me out with 1000', '1000'], ['can you spot me five hundred', '500'], ['i need 2.5k for the deposit', '2500'],
    ['my card got declined, can you cover me $1000', '1000'],
  ];
  for (const [text, amount] of cases) {
    const s = suggest(text);
    assert.equal(s.ask, true, `ask: ${text}`);
    assert.equal(s.amount, amount, `amount: ${text}`);
    assert.ok(['Someone is asking you for money', 'Money request with pressure'].includes(classify(text)?.title), text);
  }
});

test('ordinary numbers and plans are not money asks', () => {
  for (const text of ['send me the 2024 photos', 'I need to be there at 530', 'the game was 100% fun', 'can you send me your address', 'we are 1000 miles away', 'lets get dinner'])
    assert.equal(suggest(text).ask, false, text);
});
