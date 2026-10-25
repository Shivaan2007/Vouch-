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
  assert.match(texts()[0].text, /Nothing stands out/);
  assert.match(texts()[0].text, /only a Yes/);
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
