import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../telegram-bot.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";

function harness(opts = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    sent.push({ method, body: JSON.parse(init.body) });
    return { json: async () => ({ ok: true, result: [] }) };
  };
  const bot = createBot({ token: 'TEST', fetchImpl, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }), ...opts });
  const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => ({ to: String(s.body.chat_id), text: s.body.text }));
  const say = (chat, text, extra = {}) => bot.handleUpdate({ update_id: 1, message: { chat: { id: chat, type: extra.type || 'private' }, from: { first_name: extra.name || 'Gran', is_bot: false }, text } });
  return { bot, sent, texts, say };
}

test('private scam message gets an immediate warning', async () => {
  const { texts, say } = harness();
  await say(1, SCAM);
  const [m] = texts();
  assert.match(m.text, /SCAM WARNING/);
  assert.match(m.text, /gift cards/);
});

test('private clean message gets a calm answer that does not clear it', async () => {
  const { texts, say } = harness();
  await say(1, 'dinner is at six, bring dessert');
  assert.match(texts()[0].text, /don't see anything in that asking for money/);
  assert.match(texts()[0].text, /check it with their own phone in Vouch/);
});

test('groups stay quiet unless something looks wrong', async () => {
  const { texts, say } = harness();
  await say(-5, 'see you at six', { type: 'group' });
  assert.equal(texts().length, 0);
  await say(-5, 'I need some money for the bus', { type: 'group' });
  assert.match(texts()[0].text, /asks for money/);
  await say(-5, SCAM, { type: 'group' });
  assert.match(texts()[1].text, /SCAM WARNING/);
});

test('guardians are alerted without the message text', async () => {
  const { texts, say } = harness({ guardians: [900] });
  await say(-5, SCAM, { type: 'group', name: 'Grandma' });
  const alerts = texts().filter((t) => t.to === '900');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Grandma/);
  assert.doesNotMatch(alerts[0].text, /zebra|\$200/);
});

test('/guardian registers a chat, and it is not alerted about its own messages', async () => {
  const { bot, texts, say } = harness();
  await say(700, '/guardian', { type: 'group' });
  assert.ok(bot.guardianChats.has('700'));
  await say(1, SCAM);
  assert.equal(texts().filter((t) => t.to === '700' && /Heads-up/.test(t.text)).length, 1);
  await say(700, SCAM, { type: 'group' });
  assert.equal(texts().filter((t) => t.to === '700' && /Heads-up/.test(t.text)).length, 1);
});

test('a broken analyzer never silences the warning', async () => {
  const { texts, say } = harness({ analyze: async () => { throw new Error('boom'); } });
  await say(1, SCAM);
  assert.match(texts()[0].text, /SCAM WARNING/);
});

test('bots and empty updates are ignored', async () => {
  const { texts, bot } = harness();
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { is_bot: true }, text: SCAM } });
  await bot.handleUpdate({ update_id: 2 });
  await bot.handleUpdate(undefined);
  assert.equal(texts().length, 0);
});

test('saying hello to the bot gets a conversation, not a scam analysis', async () => {
  const { texts, say } = harness();
  for (const hello of ['yo', 'hi', 'Hello!', 'thanks', 'what do you do?']) {
    await say(1, hello);
  }
  const all = texts().map((t) => t.text);
  assert.equal(all.length, 5);
  for (const t of all) {
    assert.match(t, /I'm Vouch Alert/);
    assert.doesNotMatch(t, /Nothing stands out|SCAM|does not make it safe|asking for money or showing/);
  }
});

test('when the AI is available it answers a greeting itself, in its own words', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ method: url.split('/').pop(), body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
  const infer = async () => ({ moneyRequest: false, amountUSD: null, paymentMethod: 'unknown', risk: 'none', scamType: 'Ordinary message', impersonating: '', signals: [], why: '', steps: [], tags: [], intent: 'chat', reply: 'Hi there! Send me anything that looks off and I will tell you what I see.' });
  const bot = createBot({ token: 'T', fetchImpl, infer, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, text: 'yo' } });
  const says = sent.filter((s) => s.method === 'sendMessage');
  assert.equal(says.length, 1);
  assert.equal(says[0].body.text, 'Hi there! Send me anything that looks off and I will tell you what I see.');
});

test('a real message in a private chat waits for the AI instead of saying something premature', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ method: url.split('/').pop(), body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: 7 } }) }; };
  const infer = async () => ({ moneyRequest: true, amountUSD: 1000, paymentMethod: 'unknown', risk: 'low', scamType: 'Ordinary message', impersonating: '', signals: [], why: 'A friend asks for $1000 with nothing unusual about it.', steps: ['Check it with their own phone.'], tags: [], intent: 'message', reply: '' });
  const bot = createBot({ token: 'T', fetchImpl, infer, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, text: 'hey can you help me out, rent is due' } });
  assert.ok(sent.some((s) => s.method === 'sendChatAction' && s.body.action === 'typing'), 'shows it is thinking');
  const says = sent.filter((s) => s.method === 'sendMessage');
  assert.equal(says.length, 1, 'one answer, after the AI has read it');
  assert.match(says[0].body.text, /Someone is asking you for money/);
});