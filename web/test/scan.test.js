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

test('never throws on junk', () => {
  for (const v of [undefined, null, 42, {}, '', 'a'.repeat(100000)]) {
    assert.doesNotThrow(() => { suggest(v); callRisk(v); });
  }
});
