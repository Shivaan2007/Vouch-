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
// ---- links and pictures ----
import { extractLinks as linksOf } from '../links.js';

test('links are parsed by code and handed to the AI as facts to judge; the AI never opens them', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return reply({ ...GOOD, links: [{ url: 'amzn-redeliver.co/pay', risk: 'high', why: 'Lookalike of Amazon.', lookalikeOf: 'Amazon' }] }); };
  const r = await inferScam({ text: 'Pay the fee at amzn-redeliver.co/pay' }, { fetchImpl, apiKey: 'k' });
  const prompt = JSON.stringify(seen[0].contents);
  assert.match(prompt, /LINKS FOUND IN THE MESSAGE \(parsed by code/);
  assert.match(prompt, /host amzn-redeliver\.co/);
  assert.match(prompt, /you cannot open them/);
  assert.deepEqual(r.links, [{ url: 'amzn-redeliver.co/pay', risk: 'high', why: 'Lookalike of Amazon.', lookalikeOf: 'Amazon' }]);
  assert.equal(linksOf('nothing here').length, 0);
});

test('a picture is sent with the right type, and its findings are validated', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return reply({ ...GOOD, image: { present: true, kind: 'Fake bank alert screenshot', aiGenerated: 'possible', risk: 'high', concerns: ['urgent threat', 'odd domain', 'a', 'extra'] } }); };
  const png = 'iVBORw0KGgo=';
  const r = await inferScam({ text: '', imageBase64: png }, { fetchImpl, apiKey: 'k' });
  const inline = seen[0].contents[0].parts.find((p) => p.inline_data);
  assert.equal(inline.inline_data.mime_type, 'image/png');
  assert.match(JSON.stringify(seen[0].contents), /LINKS FOUND IN THE MESSAGE: none/);
  assert.deepEqual({ kind: r.image.kind, aiGenerated: r.image.aiGenerated, risk: r.image.risk, n: r.image.concerns.length }, { kind: 'Fake bank alert screenshot', aiGenerated: 'possible', risk: 'high', n: 3 });
  await inferScam({ text: '', imageBase64: 'UklGRg==' }, { fetchImpl, apiKey: 'k' });
  assert.equal(seen[1].contents[0].parts.find((p) => p.inline_data).inline_data.mime_type, 'image/webp');
  assert.equal(await inferScam({ text: '', imageBase64: 'not-an-image' }, { fetchImpl, apiKey: 'k' }), null, 'no text and no readable picture: nothing to read');
});

test('link and image findings are clamped, and no picture means no image block', () => {
  const c = cleanInference({
    risk: 'none', links: [{ url: 'u'.repeat(300), risk: 'high', why: 'w'.repeat(300), lookalikeOf: 'x'.repeat(100) }, { url: 'b', risk: 'bogus', why: '', lookalikeOf: '' }, null],
    image: { present: false, kind: 'x', aiGenerated: 'likely', risk: 'high', concerns: ['a'] },
  });
  assert.equal(c.links.length, 1, 'a link with an invalid risk is dropped');
  assert.ok(c.links[0].url.length <= 120 && c.links[0].why.length <= 110 && c.links[0].lookalikeOf.length <= 40);
  assert.equal(c.image, null);
  const bad = cleanInference({ risk: 'none', image: { present: true, kind: 'k', aiGenerated: 'definitely', risk: 'huge', concerns: 'nope' } });
  assert.deepEqual(bad.image, { kind: 'k', aiGenerated: 'unclear', risk: 'none', concerns: [] });
});

test('a deceptive link or picture counts on its own, even when the words sound harmless', async () => {
  const calm = { ...GOOD, moneyRequest: false, risk: 'none', scamType: 'Ordinary message', signals: [], steps: [], why: '', tags: [], links: [], image: null };
  const linkCase = createCore({ analyze: rules, infer: async () => ({ ...calm, links: [{ url: 'bit.ly/x', risk: 'high', why: 'Hides the real destination.', lookalikeOf: '' }] }) });
  const a = await linkCase.assess({ text: 'check this out bit.ly/x' });
  assert.equal(a.level, 2);
  assert.equal(a.guide.title, 'Suspicious link');
  const imageCase = createCore({ analyze: rules, infer: async () => ({ ...calm, image: { kind: 'Profile photo', aiGenerated: 'likely', risk: 'medium', concerns: ['too perfect'] } }) });
  const b = await imageCase.assess({ text: 'hi', imageBase64: 'iVBOR' });
  assert.equal(b.level, 1);
  assert.equal(b.guide.title, 'Suspicious image');
  const lowCase = createCore({ analyze: rules, infer: async () => ({ ...calm, links: [{ url: 'github.com', risk: 'low', why: 'Official site.', lookalikeOf: 'GitHub' }] }) });
  const c = await lowCase.assess({ text: 'see github.com' });
  assert.equal(c.level, 0, 'a low-risk link does not raise anything');
  assert.doesNotMatch(lowCase.reply(c), /imitates/, 'and a genuine site is never described as an imitation');
});

test('the reply lists each link with its risk, says it did not open them, and hedges about pictures', async () => {
  const core = createCore({ analyze: rules, infer: async () => ({ ...GOOD, risk: 'high', links: [{ url: 'chase-secure-verify.top', risk: 'high', why: 'Not Chase.', lookalikeOf: 'Chase' }], image: { kind: 'Fake bank alert screenshot', aiGenerated: 'likely', risk: 'high', concerns: ['urgent threat'] } }) });
  const a = await core.assess({ text: 'verify at chase-secure-verify.top', imageBase64: 'iVBOR' });
  const text = core.reply(a, { rich: false });
  assert.match(text, /Links:\n- chase-secure-verify\.top: HIGH risk \(imitates Chase\)\. Not Chase\./);
  assert.match(text, /I did not open them/);
  assert.match(text, /Image: Fake bank alert screenshot\. It looks AI-generated\. urgent threat\./);
  assert.match(text, /AI can be wrong about images/);
});

test('with no AI, the most obvious link tricks still raise the level', async () => {
  const core = createCore({ analyze: rules, infer: async () => null });
  const a = await core.assess({ text: 'confirm your account http://203.0.113.9/login' });
  assert.equal(a.ai, false);
  assert.equal(a.level, 2);
  assert.equal(a.guide.title, 'Suspicious link');
  assert.equal((await core.assess({ text: 'see https://www.amazon.com/orders' })).level, 0);
  assert.equal(core.quick('http://203.0.113.9/login').level, 2);
});

test('call audio goes to the AI once: it writes down what was said and judges the call with the earlier words', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return reply({ ...GOOD, heard: 'buy gift cards and read me the numbers', risk: 'high', moneyRequest: true }); };
  const wav = 'UklGRgAAAAA=';
  const r = await inferScam({ text: 'hello this is your bank', audioBase64: wav }, { fetchImpl, apiKey: 'k' });
  const parts = seen[0].contents[0].parts;
  assert.equal(parts.find((p) => p.inline_data).inline_data.mime_type, 'audio/wav');
  assert.match(JSON.stringify(parts), /THE CALL SO FAR/);
  assert.equal(r.heard, 'buy gift cards and read me the numbers');
  assert.equal(await inferScam({ text: '', audioBase64: 'not-a-wav' }, { fetchImpl, apiKey: 'k' }), null);
});

test('the core reads the new words together with the earlier ones, so a scam built up over a call is caught', async () => {
  const core = createCore({ analyze: rules, infer: async () => ({ ...GOOD, risk: 'none', moneyRequest: false, scamType: 'Ordinary message', signals: [], steps: [], why: '', tags: [], links: [], image: null, heard: 'go and buy apple gift cards now' }) });
  const a = await core.assess({ text: 'I am calling from your bank', audioBase64: 'UklGRgAAAAA=' });
  assert.equal(a.heard, 'go and buy apple gift cards now');
  assert.ok(a.level >= 1, 'the rules read what the AI heard');
});

test('no web address can ride along inside the AI sentences that reach people', () => {
  const c = cleanInference({ risk: 'high', scamType: 'Fake bank', why: 'Go to chase-verify.top/login now or visit https://evil.example/x', steps: ['Do not open www.evil.com', 'Call your bank'], signals: ['pushes login.paypa1.com'], reply: 'see bit.ly/abc',
    links: [{ url: 'chase-verify.top/login', risk: 'high', why: 'Not chase.com', lookalikeOf: 'Chase' }] });
  assert.doesNotMatch(JSON.stringify([c.why, c.steps, c.signals, c.reply, c.links[0].why]), /chase-verify|evil|paypa1|bit\.ly|chase\.com/);
  assert.equal(c.links[0].url, 'chase-verify.top/login', 'the links list itself still shows the address, as text with a risk');
  assert.match(c.why, /\[link\]/);
});

test('a first model that stalls does not eat the whole budget: the next one is started and the first good answer wins', async () => {
  const order = [];
  const fetchImpl = (url, init) => {
    const name = /models\/([^:]+):/.exec(String(url))[1];
    order.push(name);
    if (order.length === 1) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); // stalls forever
    return Promise.resolve(reply({ ...GOOD }));
  };
  const t0 = Date.now();
  const r = await inferScam({ text: 'please send $100 in gift cards' }, { fetchImpl, apiKey: 'k', hedgeMs: 40, timeoutMs: 2000 });
  assert.ok(r, 'got an answer from the second model');
  assert.ok(Date.now() - t0 < 1000, 'without waiting for the stalled one');
  assert.equal(order.length, 2);
});

test('when every model fails, the read is null and nothing is left running', async () => {
  const r = await inferScam({ text: 'please send $100 in gift cards' }, { fetchImpl: async () => ({ ok: false }), apiKey: 'k', hedgeMs: 20, timeoutMs: 500 });
  assert.equal(r, null);
});

test('a picture the AI thinks was computer-generated raises a hedged check, never a stop by itself', async () => {
  const calm = { ...GOOD, moneyRequest: false, risk: 'none', scamType: 'Ordinary message', signals: [], steps: [], why: '', tags: [], links: [], heard: '' };
  const core = createCore({ analyze: rules, infer: async () => ({ ...calm, image: { kind: 'Profile photo', aiGenerated: 'likely', risk: 'none', concerns: [] } }) });
  const a = await core.assess({ text: '', imageBase64: 'iVBOR' });
  assert.equal(a.level, 1);
  assert.equal(a.guide.title, 'Possibly an AI-made picture');
  assert.match(a.guide.why, /only a hint/);
  const maybe = createCore({ analyze: rules, infer: async () => ({ ...calm, image: { kind: 'Photo', aiGenerated: 'possible', risk: 'none', concerns: [] } }) });
  assert.equal((await maybe.assess({ text: '', imageBase64: 'iVBOR' })).level, 0, 'only "likely" counts; "possible" is too weak to bother anyone');
});