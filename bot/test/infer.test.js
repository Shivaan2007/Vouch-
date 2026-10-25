import test from 'node:test';
import assert from 'node:assert/strict';
import { inferScam, cleanInference } from '../infer.js';
import { createCore, createContext, aiLevel } from '../core.js';

const GOOD = {
  moneyRequest: true, amountUSD: 1000, paymentMethod: 'venmo_cashapp_zelle', risk: 'medium', scamType: 'Friend in a bind',
  impersonating: 'a friend', signals: ['"need 1000 dollars"', 'new number'], why: 'Someone is asking for $1000 from a new number.',
  steps: ['Do not send yet.', 'Call them on the number you have.'], tags: ['NEW_NUMBER'],
};
const reply = (obj) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });

test('asks Gemini for a structured read, treats the message as untrusted, and passes the earlier messages', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return reply(GOOD); };
  const r = await inferScam({ text: 'hey I need 1000 dollars', context: ['hi it is me', 'new number'] }, { fetchImpl, apiKey: 'k' });
  assert.equal(r.scamType, 'Friend in a bind');
  assert.equal(r.amountUSD, 1000);
  const sent = JSON.parse(seen[0].init.body);
  const prompt = JSON.stringify(sent.contents);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /EARLIER MESSAGES FROM THE SAME SENDER/);
  assert.match(prompt, /new number/);
  assert.match(prompt, /hey I need 1000 dollars/);
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal(seen[0].init.headers['x-goog-api-key'], 'k', 'the key is a header, never in the address');
  assert.doesNotMatch(seen[0].url, /key=/);
});

test('falls to the next model when one is rate limited, and gives up cleanly when none work', async () => {
  let n = 0;
  const flaky = async () => { n += 1; return n === 1 ? { ok: false, status: 429 } : reply(GOOD); };
  assert.equal((await inferScam({ text: 'need money' }, { fetchImpl: flaky, apiKey: 'k' })).risk, 'medium');
  assert.equal(n, 2);
  const dead = async () => ({ ok: false, status: 500 });
  assert.equal(await inferScam({ text: 'need money' }, { fetchImpl: dead, apiKey: 'k' }), null);
  const throws = async () => { throw new Error('offline'); };
  assert.equal(await inferScam({ text: 'need money' }, { fetchImpl: throws, apiKey: 'k' }), null);
  assert.equal(await inferScam({ text: 'need money' }, { fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }), apiKey: 'k' }), null);
});

test('no key, no input, or too slow means null (the rules take over)', async () => {
  assert.equal(await inferScam({ text: 'x' }, { fetchImpl: async () => reply(GOOD), apiKey: '' }), null);
  assert.equal(await inferScam({ text: '   ' }, { fetchImpl: async () => reply(GOOD), apiKey: 'k' }), null);
  const slow = (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const t0 = Date.now();
  assert.equal(await inferScam({ text: 'need money' }, { fetchImpl: slow, apiKey: 'k', timeoutMs: 80 }), null);
  assert.ok(Date.now() - t0 < 1000);
});

test('whatever the model returns is validated and clamped', () => {
  const c = cleanInference({
    moneyRequest: 'yes', amountUSD: -5, paymentMethod: 'bitcoin-atm', risk: 'high', scamType: 'x'.repeat(200),
    impersonating: 'y'.repeat(200), signals: ['a', '', 'b', 'c', 'd', 'e'], why: 'w'.repeat(500), steps: ['1', '2', '3', '4'],
    tags: ['URGENCY', 'MADE_UP', 'FIRST_REQUEST'],
  });
  assert.equal(c.moneyRequest, false, 'only a real boolean true counts');
  assert.equal(c.amountUSD, null);
  assert.equal(c.paymentMethod, 'unknown');
  assert.ok(c.scamType.length <= 48);
  assert.equal(c.signals.length, 4);
  assert.equal(c.why.length, 160);
  assert.equal(c.steps.length, 3);
  assert.deepEqual(c.tags, ['URGENCY'], 'unknown tags and the server-only first-request tag are dropped');
  assert.equal(cleanInference({ risk: 'bogus' }), null);
  assert.equal(cleanInference(null), null);
});

const rules = async () => ({ tags: [], paymentRisk: 'low', explanation: '' });

test('the AI infers; the rules are only the floor: it can raise a level and never lower it', async () => {
  // a calm-looking message the rules call fine: the AI sees an impersonation and raises it
  const raise = createCore({ analyze: rules, infer: async () => ({ ...GOOD, risk: 'high', scamType: 'Cloned-voice relative', impersonating: 'your grandson' }) });
  const a = await raise.assess({ text: 'grandma its me i lost my phone' });
  assert.equal(a.level, 2);
  assert.equal(a.guide.title, 'Cloned-voice relative');
  assert.equal(a.impersonating, 'your grandson');
  assert.equal(a.ai, true);
  // the rules see a gift-card scam; an AI that says "none" cannot talk it down
  const calm = createCore({ analyze: rules, infer: async () => ({ ...GOOD, moneyRequest: false, risk: 'none', scamType: 'Ordinary message', signals: [], steps: [] }) });
  const b = await calm.assess({ text: 'please buy apple gift cards right now and read me the codes' });
  assert.equal(b.level, 2, 'a rule-based stop stands');
});

test('an ordinary-looking request from a friend is still a money ask, in plain words', async () => {
  const core = createCore({ analyze: rules, infer: async () => ({ ...GOOD, risk: 'low', scamType: 'Ordinary message', signals: [], tags: [], impersonating: '' }) });
  const a = await core.assess({ text: 'hey I need 1000 dollars' });
  assert.equal(a.level, 1);
  assert.equal(a.guide.title, 'Someone is asking you for money');
  assert.equal(aiLevel(null), 0);
});

test('with no AI the instant rules and the server analysis still answer', async () => {
  const core = createCore({ analyze: async () => ({ tags: ['GIFT_CARD'], paymentRisk: 'high', explanation: 'x' }), infer: async () => null });
  const a = await core.assess({ text: 'buy gift cards' });
  assert.equal(a.ai, false);
  assert.equal(a.level, 2);
  const broken = createCore({ analyze: async () => { throw new Error('x'); }, infer: async () => { throw new Error('y'); } });
  assert.equal((await broken.assess({ text: 'buy gift cards' })).level, 2);
});

test('the reply names what the AI found, quotes what stood out, and says it was read by AI', async () => {
  const core = createCore({ analyze: rules, infer: async () => GOOD, vouchUrl: '' });
  const a = await core.assess({ text: 'hey I need 1000 dollars from my new number' });
  const text = core.reply(a, { rich: false });
  assert.match(text, /SCAM WARNING/);
  assert.match(text, /Friend in a bind/);
  assert.match(text, /What stood out:\n- "need 1000 dollars"/);
  assert.match(text, /It claims to be: a friend/);
  assert.match(text, /Read by AI, which can warn but never clear/);
  assert.doesNotMatch(text, /⚠/);
});

test('context is kept per sender in memory only, and forgets', () => {
  const m = createContext({ keep: 3, ttlMs: 50 });
  for (const t of ['a', 'b', 'c', 'd']) m.add('chat:1', t);
  assert.deepEqual(m.get('chat:1'), ['b', 'c', 'd']);
  assert.deepEqual(m.get('chat:2'), []);
  return new Promise((r) => setTimeout(r, 80)).then(() => assert.deepEqual(m.get('chat:1'), []));
});

test('long text is shortened at a word, not in the middle of one', () => {
  const c = cleanInference({ risk: 'low', scamType: 'a', why: 'w', steps: ['Do not wire any money until you speak directly with your agent or title officer in person or on a trusted phone line that you already know and can verify yourself carefully'], signals: [], tags: [], intent: 'message', reply: '' });
  assert.ok(c.steps[0].length <= 150);
  assert.match(c.steps[0], /\w$/, 'ends on a whole word');
  assert.ok(!/ [a-z]{1,2}$/i.test(c.steps[0]) || c.steps[0].length < 150);
});

test('chat intent and the reply are carried through, and default to a message', () => {
  assert.equal(cleanInference({ risk: 'none', intent: 'chat', reply: 'Hi there' }).intent, 'chat');
  assert.equal(cleanInference({ risk: 'none', intent: 'chat', reply: 'Hi there' }).reply, 'Hi there');
  assert.equal(cleanInference({ risk: 'none' }).intent, 'message');
  assert.equal(cleanInference({ risk: 'none', intent: 'weird' }).intent, 'message');
});