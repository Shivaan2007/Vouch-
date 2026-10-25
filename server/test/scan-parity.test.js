import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectTags } from '../src/risk/rules.js';
import { suggest } from '../../web/js/lib/scan.js';

// The phone's instant hints (web/js/lib/scan.js, Sayan's) are a simpler copy of the server's phrase rules
// (server/src/risk/rules.js). They only warn, and the result screen shows both lists together, but they should agree so
// the warning on the phone is the same one the server gives a moment later.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scams.json', import.meta.url), 'utf8'));
const phone = (text) => suggest(text).tags.sort();
const server = (text) => detectTags(text).filter((t) => t !== 'FIRST_REQUEST').sort();

const EVERYDAY = [
  'can you pay for dinner tonight?', 'I need to pay my rent, can you cover half?', 'the fee for the ticket is $15',
  'my card got declined at the store, can you help', 'send me the photo',
  'see you at six', 'can you steam clean the couch for $40', 'the wire in my lamp broke', 'I am on google play',
  'thanks for lunch, I will venmo you $12', 'happy birthday!',
];

test('ordinary messages: phone hints and server rules give the same tags', () => {
  for (const f of fixtures.normal) assert.deepEqual(phone(f.text), server(f.text), f.text);
  for (const t of EVERYDAY) assert.deepEqual(phone(t), server(t), t);
});

test('gift card and crypto tags agree on every scam fixture', () => {
  const pick = (tags) => tags.filter((t) => t === 'GIFT_CARD' || t === 'CRYPTO');
  for (const f of fixtures.scams) assert.deepEqual(pick(phone(f.text)), pick(server(f.text)), f.text);
});

// Known drift on main: the phone misses "rn", "delete this message" and "by wire", and flags "stuck"/"stranded" as
// urgency when the server does not (so "I am stuck in traffic" differs). demo/scan-js-parity.patch fixes all four; apply it, then delete the todo flag.
test('scam fixtures: phone hints and server rules give the same tags',
  { todo: 'apply demo/scan-js-parity.patch to web/js/lib/scan.js, then remove this flag' }, () => {
    for (const f of fixtures.scams) assert.deepEqual(phone(f.text), server(f.text), f.text);
    assert.deepEqual(phone("I am stuck in traffic, running late"), server("I am stuck in traffic, running late"));
  });
