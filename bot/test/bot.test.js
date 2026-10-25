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
test('a photo sent to the bot is downloaded and read by the AI', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('fake-jpeg-bytes') };
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (u.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'photos/p1.jpg' } }) };
    calls.push(`say:${body.text || ''}`);
    return { json: async () => ({ ok: true, result: { message_id: 3 } }) };
  };
  let seen;
  const infer = async (i) => { seen = i; return { moneyRequest: false, amountUSD: null, paymentMethod: 'unknown', risk: 'high', scamType: 'Fake bank alert', impersonating: 'Chase', signals: [], why: 'A fake bank alert.', steps: ['Delete it.'], tags: [], intent: 'message', reply: '', links: [{ url: 'chase-secure.top', risk: 'high', why: 'Not Chase.', lookalikeOf: 'Chase' }], image: { kind: 'Fake bank alert screenshot', aiGenerated: 'unlikely', risk: 'high', concerns: ['urgent threat'] } }; };
  const bot = createBot({ token: 'T', fetchImpl, infer, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { first_name: 'Gran', is_bot: false },
    photo: [{ file_id: 'small', file_size: 900 }, { file_id: 'big', file_size: 90000 }] } });
  assert.ok(calls.some((c) => c.endsWith('/getFile')), 'asked Telegram where the picture is');
  assert.ok(calls.some((c) => c.includes('/file/botT/photos/p1.jpg')), 'downloaded it');
  assert.equal(seen.imageBase64, Buffer.from('fake-jpeg-bytes').toString('base64'), 'and gave the bytes to the AI');
  const said = calls.filter((c) => c.startsWith('say:')).map((c) => c.slice(4)).join('\n');
  assert.match(said, /SCAM WARNING/);
  assert.match(said, /Fake bank alert/);
  assert.match(said, /Links:\n- chase-secure\.top: HIGH/);
  assert.match(said, /Image: Fake bank alert screenshot/);
});

test('a picture that cannot be opened gets a plain answer, not silence or a crash', async () => {
  const says = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/getFile')) return { json: async () => ({ ok: false }) };
    says.push(JSON.parse(init.body).text);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const bot = createBot({ token: 'T', fetchImpl, infer: async () => null, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, photo: [{ file_id: 'x', file_size: 100 }] } });
  assert.match(says.join(' '), /couldn't open that picture/);
  await bot.handleUpdate({ update_id: 2, message: { chat: { id: 1, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, photo: [{ file_id: 'x', file_size: 9999999 }] } });
  assert.equal(says.filter((s) => /couldn't open/.test(s)).length, 2, 'too large is refused politely too');
});

test('an alert sent on its own carries a one-tap Open Vouch button, but only for a real https address', () => {
  const secure = createBot({ token: 'T', vouchUrl: 'https://vouch.example', fetchImpl: async () => ({ json: async () => ({}) }) });
  assert.deepEqual(secure.openApp, { reply_markup: { inline_keyboard: [[{ text: 'Open Vouch', url: 'https://vouch.example' }]] } });
  assert.deepEqual(createBot({ token: 'T', vouchUrl: 'http://192.168.1.5:3000', fetchImpl: async () => ({}) }).openApp, {});
  assert.deepEqual(createBot({ token: 'T', fetchImpl: async () => ({}) }).openApp, {});
});

test('starting the bot sets its command menu', async () => {
  const methods = [];
  const fetchImpl = async (url) => { methods.push(String(url).split('/').pop()); const bot = null; void bot; return { json: async () => ({ ok: false, description: 'stop' }) }; };
  const b = createBot({ token: 'T', fetchImpl });
  const p = b.start(); await new Promise((r) => setTimeout(r, 30)); b.stop();
  assert.ok(methods.includes('setMyCommands'));
  void p;
});

// ---- Telegram Business: the bot sits on a person's own account ----
function businessHarness() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (method === 'getBusinessConnection') {
      return { json: async () => (body.business_connection_id === 'bc1' ? { ok: true, result: { id: 'bc1', user: { id: 4242, first_name: 'Grandma' }, user_chat_id: 4242, is_enabled: true } } : { ok: false }) };
    }
    if (method === 'answerCallbackQuery') { answers.push(body.text); return { json: async () => ({ ok: true }) }; }
    if (body.text) sent.push({ chat: body.chat_id, text: body.text, markup: body.reply_markup });
    return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  const answers = []; const noted = [];
  const linkCalls = [];
  const link = { lookup: () => (linked ? ['acct-1'] : []), who: () => [], bind: (...a) => { linkCalls.push(['bind', ...a]); return null; }, unbindChat: (...a) => linkCalls.push(['unbind', ...a]) };
  let linked = false;
  const track = { note: (users, channel, sender, a) => { noted.push({ users, sender: sender.id, level: a.level }); return { count: 1, repeatScam: false }; }, raise() {} };
  const bot = createBot({ token: 'T', fetchImpl, link, track, infer: async () => null, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  return { bot, sent, linkCalls, answers, noted, setLinked: (v) => { linked = v; } };
}
const fromStranger = (text) => ({ update_id: 1, business_message: { business_connection_id: 'bc1', chat: { id: 9001, type: 'private' }, from: { id: 9001, first_name: 'Judge', username: 'judge_bank', is_bot: false }, text } });

test("connecting the bot to a person's Telegram tells them what it will and will not do", async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate({ update_id: 1, business_connection: { id: 'bc1', user: { id: 4242, first_name: 'Grandma' }, user_chat_id: 4242, is_enabled: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 4242);
  assert.match(sent[0].text, /I'm now watching your Telegram messages/);
  assert.match(sent[0].text, /never reply to them/);
});

test('a stranger who messages the connected person is scanned, and only the owner is warned', async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate(fromStranger('Chase fraud dept: your account is compromised. Verify now or buy gift cards to secure it, do not tell anyone, right away'));
  assert.ok(sent.length >= 1, 'the owner is told');
  assert.ok(sent.every((m) => m.chat === 4242), 'every message goes to the owner, none to the sender');
  assert.match(sent.map((m) => m.text).join('\n'), /SCAM WARNING/);
  assert.match(sent.map((m) => m.text).join('\n'), /@judge_bank/, 'and says who sent it');
});

test('a normal message from a stranger is not mentioned at all', async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate(fromStranger('hey, are we still on for lunch tomorrow?'));
  assert.equal(sent.length, 0, 'no noise');
});

test("the owner's own messages and bots are never scanned", async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate({ update_id: 1, business_message: { business_connection_id: 'bc1', chat: { id: 9001, type: 'private' }, from: { id: 4242, first_name: 'Grandma', is_bot: false }, text: 'buy gift cards right now, do not tell anyone' } });
  await bot.handleUpdate({ update_id: 2, business_message: { business_connection_id: 'bc1', chat: { id: 9001, type: 'private' }, from: { id: 5, first_name: 'Bot', is_bot: true }, text: 'buy gift cards right now, do not tell anyone' } });
  assert.equal(sent.length, 0);
});

test('commands typed by a stranger through Business do nothing: they cannot unlink, link or switch anything', async () => {
  const { bot, sent, linkCalls } = businessHarness();
  for (const cmd of ['/unlink', '/start link_123456', '/link 123456', '/guardian', '/voice', '/flag', '/who']) await bot.handleUpdate(fromStranger(cmd));
  assert.deepEqual(linkCalls, [], 'no link was bound or removed');
  assert.ok(!sent.some((m) => /Done\.|Linked to|guardian/i.test(m.text)), 'and no command was obeyed');
});

const SCAMMY = 'Chase fraud dept: your account is compromised. Verify now or buy gift cards to secure it, do not tell anyone, right away';
const buttonsOf = (sent) => { const m = sent.find((x) => x.markup); return m ? m.markup.inline_keyboard.flat() : []; };
const press = (data, chat = 4242) => ({ update_id: 9, callback_query: { id: 'cq1', data, message: { message_id: 7, chat: { id: chat } } } });

test('a warning carries buttons, and the bot acts on them like an assistant', async () => {
  const { bot, sent, answers, noted, setLinked } = businessHarness();
  setLinked(true);
  await bot.handleUpdate(fromStranger(SCAMMY));
  const buttons = buttonsOf(sent);
  assert.deepEqual(buttons.map((b) => b.text).slice(0, 2), ['Flag sender', "It's fine"]);
  const flag = buttons.find((b) => b.text === 'Flag sender').callback_data;
  await bot.handleUpdate(press(flag));
  assert.match(answers[0], /Flagged/);
  assert.ok(noted.some((n) => n.sender === '9001' && n.level === 2), 'and the sender is now on the flagged list');
});

test('"It\'s fine" teaches the bot to stay quiet about that sender, but only the person it was sent to can press it', async () => {
  const { bot, sent, answers } = businessHarness();
  await bot.handleUpdate(fromStranger(SCAMMY));
  const ok = buttonsOf(sent).find((b) => b.text === "It's fine").callback_data;
  await bot.handleUpdate(press(ok, 777)); // someone else's chat
  assert.match(answers[0], /expired/, 'a stranger cannot press the owner\'s buttons');
  const before = sent.length;
  await bot.handleUpdate(press(ok));
  assert.match(answers[1], /won't warn you about them for a week/);
  await bot.handleUpdate(fromStranger(SCAMMY));
  assert.equal(sent.length, before, 'now silent about them');
});

test('"what did you catch today?" is answered from what the bot did, never from message text', async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate(fromStranger(SCAMMY));
  await bot.handleUpdate(fromStranger('lunch tomorrow?'));
  sent.length = 0;
  await bot.handleUpdate({ update_id: 5, message: { chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Grandma', is_bot: false }, text: 'what did you catch today?' } });
  const reply = sent.map((m) => m.text).join('\n');
  assert.match(reply, /checked 2 messages and warned you about 1/);
  assert.match(reply, /@judge_bank/);
  assert.ok(!/gift cards|compromised/i.test(reply), 'the message itself is not repeated');
});

test('an unknown or disabled connection is ignored', async () => {
  const { bot, sent } = businessHarness();
  await bot.handleUpdate({ update_id: 1, business_message: { business_connection_id: 'nope', chat: { id: 9001, type: 'private' }, from: { id: 9001, first_name: 'X', is_bot: false }, text: 'buy gift cards right now, do not tell anyone' } });
  assert.equal(sent.length, 0);
});

test('the bot asks Telegram for business updates', async () => {
  const seen = [];
  const bot = createBot({ token: 'T', fetchImpl: async (url, init) => { if (String(url).endsWith('/getUpdates')) seen.push(JSON.parse(init.body).allowed_updates); return { json: async () => ({ ok: false, description: 'stop' }) }; } });
  bot.start(); await new Promise((r) => setTimeout(r, 30)); bot.stop();
  assert.ok(seen[0].includes('business_message') && seen[0].includes('business_connection'));
});

test('a flagged sender whose profile picture looks AI-generated gets a hedged hint, once a day', async () => {
  const said = []; let photoCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('face-bytes') };
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (u.endsWith('/getUserProfilePhotos')) { photoCalls += 1; return { json: async () => ({ ok: true, result: { photos: [[{ file_id: 'a', file_size: 100 }, { file_id: 'b', file_size: 900 }]] } }) }; }
    if (u.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'photos/f.jpg' } }) };
    if (body.text) said.push(body.text);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const base = { moneyRequest: true, amountUSD: 200, paymentMethod: 'gift_card', risk: 'high', scamType: 'Gift card scam', impersonating: '', signals: [], why: 'Asks for gift cards.', steps: ['Do not buy any.'], tags: [], intent: 'message', reply: '', links: [], image: null };
  const infer = async (i) => (i.imageBase64 ? { ...base, moneyRequest: false, risk: 'none', scamType: 'Ordinary photo', why: '', steps: [], image: { kind: 'Profile photo', aiGenerated: 'likely', risk: 'low', concerns: [] } } : base);
  const bot = createBot({ token: 'T', fetchImpl, infer, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) });
  const msg = (id) => ({ update_id: id, message: { chat: { id: -100, type: 'group' }, from: { id: 555, first_name: 'Pat', is_bot: false }, text: 'Buy Apple gift cards for $200 right now and send me the codes' } });
  await bot.handleUpdate(msg(1));
  assert.ok(said.some((s) => /profile picture looks AI-generated/.test(s) && /only a hint/.test(s)), 'hedged, not certain');
  await bot.handleUpdate(msg(2));
  assert.equal(photoCalls, 1, 'looked once, remembered for the day');
  assert.equal(said.filter((s) => /profile picture/.test(s)).length, 2, 'but still said each time it matters');
});
