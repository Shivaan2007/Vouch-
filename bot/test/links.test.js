import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, describeLinks, linkFloor } from '../links.js';

test('pulls links out of ordinary text and takes them apart', () => {
  const l = extractLinks('Your order could not be delivered. Pay the $1.99 fee at amzn-redeliver.co/pay-now or see https://www.amazon.com/orders. Thanks!');
  assert.deepEqual(l.map((x) => x.host), ['amzn-redeliver.co', 'www.amazon.com']);
  assert.equal(l[0].hyphens, 1);
  assert.equal(l[0].loginWords, true);
  assert.equal(l[1].loginWords, false);
  assert.equal(l[0].url, 'amzn-redeliver.co/pay-now');
});

test('spots the structural tricks without judging the brand', () => {
  const l = extractLinks('http://192.168.4.7/login  https://bit.ly/3xYz  https://paypal.com@evil.example/pay  https://xn--pypal-4ve.com/  https://secure.login.account.paypal.com.verify-now.xyz/');
  const by = Object.fromEntries(l.map((x) => [x.host, x]));
  assert.equal(by['192.168.4.7'].ip, true);
  assert.equal(by['bit.ly'].shortener, true);
  assert.equal(l.find((x) => x.url.includes('paypal.com@')).userinfo, true);
  assert.equal(l.find((x) => x.host.startsWith('xn--')).punycode, true);
  const deep = l.find((x) => x.host.endsWith('.xyz'));
  assert.ok(deep.subdomains >= 3 && deep.riskyTld);
});

test('ordinary words and numbers are not links', () => {
  for (const t of ['dinner at 6.30 pm', 'I owe you 10.5 dollars', 'see you at the gym. bye.', 'e.g. maybe', 'version 2.0 is out']) assert.deepEqual(extractLinks(t), [], t);
  assert.deepEqual(extractLinks(undefined), []);
  assert.deepEqual(extractLinks('x'.repeat(100000)), []);
});

test('describes links as facts for the AI, and the offline floor only catches the unmistakable', () => {
  const l = extractLinks('go to http://203.0.113.9/verify now');
  assert.match(describeLinks(l), /raw IP address/);
  assert.equal(linkFloor(l), 'high');
  assert.equal(linkFloor(extractLinks('https://www.amazon.com/orders')), 'none');
  assert.equal(linkFloor(extractLinks('https://bit.ly/abc')), 'medium');
  assert.equal(linkFloor([]), 'none');
});

test('caps how many links are read', () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://site${i}.example.com/p`).join(' ');
  assert.equal(extractLinks(many).length, 5);
});
