// The Watch service attached to the REAL Vouch server, with a real signed-in phone over a real socket.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createVouchServer } from '../../server/src/app.js';
import { attachWatch } from '../watch.js';
import { twilioSignature } from '../twilio-webhook.js';
import { authString } from '../../web/js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString } from '../../web/js/lib/crypto.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";
const sent = [];
const calls = [];
let aiNext = null; // lets a test make the AI say something specific
let server; let watch; let url; let phone;
const PUBLIC = 'https://example.test';

// A fake outside world: Telegram, Twilio and Gemini.
const fetchImpl = async (u, init) => {
  const s = String(u);
  calls.push({ url: s, init });
  if (s.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'vouch_test_bot' } }) };
  if (s.includes('api.telegram.org')) { sent.push({ ...JSON.parse(init.body), _m: s.split('/').pop() }); return { json: async () => ({ ok: true, result: { message_id: sent.length } }) }; }
  if (s.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: ' send me gift cards ' }] } }] }) };
  return { ok: true, json: async () => ({}) };
};

async function signedInPhone(name) {
  const keys = await createIdentityKeys();
  const pubs = { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
  const nonce = await new Promise((r) => socket.once('auth:challenge', (m) => r(m.nonce)));
  const call = (ev, body = {}) => new Promise((r) => socket.emit(ev, body, r));
  const res = await call('user:register', { name, ...pubs, sig: await signString(keys.signKeyPair.privateKey, authString(nonce)) });
  assert.equal(res.ok, true);
  const alerts = [];
  socket.on('scam:alert', (a) => alerts.push(a));
  return { socket, call, alerts, id: res.userId };
}

before(async () => {
  process.env.GEMINI_API_KEY = ''; // the speech tests set it when they need it
  server = createVouchServer({ log: () => {} });
  watch = attachWatch({
    httpServer: server.httpServer, io: server.io, db: server.db, fetchImpl, startTelegram: false,
    analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }),
    infer: async (i) => (aiNext ? aiNext(i) : null),
    env: { BOT_TOKEN: 'TESTTOKEN', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', PUBLIC_URL: PUBLIC, TWILIO_FROM: '+15550001', TWILIO_WHATSAPP_FROM: 'whatsapp:+15550002' },
  });
  url = `http://localhost:${await server.listen(0)}`;
  phone = await signedInPhone('Gran');
  await new Promise((r) => setTimeout(r, 50)); // getMe resolves
});
after(async () => { phone.socket.close(); await server.close(); });

const tg = (chat, text, type = 'private') => watch.telegram.handleUpdate({ update_id: 1, message: { chat: { id: chat, type }, from: { first_name: 'Gran', is_bot: false }, text } });
const lastTg = () => sent[sent.length - 1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the app can see which message doors exist', async () => {
  const r = await phone.call('watch:status');
  assert.equal(r.ok, true);
  const ids = r.channels.map((c) => c.id);
  assert.deepEqual(ids, ['telegram', 'sms', 'whatsapp']);
  assert.equal(r.channels[0].handle, '@vouch_test_bot');
  assert.deepEqual(r.linked, []);
});

test('an unlinked chat gets a reply but nothing reaches the app', async () => {
  phone.alerts.length = 0;
  await tg(900, SCAM);
  assert.match(lastTg().text, /SCAM WARNING/);
  await wait(150);
  assert.equal(phone.alerts.length, 0);
});

test('linking with a one-time code, then a flagged message flashes in the app (without the message)', async () => {
  const { code } = await phone.call('watch:link');
  assert.match(code, /^\d{6}$/);
  await tg(901, `/link 000000`);
  assert.match(lastTg().text, /wrong or has expired/);
  await tg(901, `/link ${code}`);
  assert.match(lastTg().text, /Linked to Gran/);
  await tg(901, `/link ${code}`);
  assert.match(lastTg().text, /wrong or has expired/, 'a code works once');

  phone.alerts.length = 0;
  await tg(901, SCAM);
  await wait(200);
  assert.equal(phone.alerts.length, 1);
  const a = phone.alerts[0];
  assert.equal(a.level, 2);
  assert.equal(a.source, 'telegram');
  assert.ok(a.title && a.steps.length >= 2, 'a plain-words guide');
  assert.doesNotMatch(JSON.stringify(a), /zebra|\$200/, 'the message itself never reaches the app payload');
  assert.deepEqual((await phone.call('watch:status')).linked, ['telegram']);
});

test('a calm message from a linked chat does not flash the app', async () => {
  phone.alerts.length = 0;
  await tg(901, 'dinner is at six');
  await wait(150);
  assert.equal(phone.alerts.length, 0);
});

test('unlinking stops the alerts', async () => {
  await phone.call('watch:unlink', { channel: 'telegram' });
  phone.alerts.length = 0;
  await tg(901, SCAM);
  await wait(150);
  assert.equal(phone.alerts.length, 0);
});

test('SMS on the same web address: signed, links with a code, and flashes the app', async () => {
  const post = async (params, signed = true) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (signed) headers['x-twilio-signature'] = twilioSignature('tok', `${PUBLIC}/watch/twilio`, params);
    const res = await fetch(`${url}/watch/twilio`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
    return { status: res.status, body: await res.text() };
  };
  assert.equal((await post({ From: '+15557770000', Body: SCAM }, false)).status, 403);
  const { code } = await phone.call('watch:link');
  const linked = await post({ From: '+15557770000', Body: `link ${code}` });
  assert.match(linked.body, /Linked to Gran/);
  phone.alerts.length = 0;
  const r = await post({ From: '+15557770000', Body: SCAM });
  assert.match(r.body, /SCAM WARNING/);
  await wait(200);
  assert.equal(phone.alerts.length, 1);
  assert.equal(phone.alerts[0].source, 'sms');
  // the app itself is still served on the same address
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('the call listener: needs sign-in, validates input, reports a missing key, and returns the words', async () => {
  const stranger = ioClient(url, { transports: ['websocket'], reconnection: false });
  await new Promise((r) => stranger.once('auth:challenge', r));
  assert.equal((await new Promise((r) => stranger.emit('watch:listen', { wav: 'AAAA' }, r))).error, 'UNAUTHENTICATED');
  stranger.close();

  assert.equal((await phone.call('watch:listen', {})).error, 'BAD_INPUT');
  assert.equal((await phone.call('watch:listen', { wav: 'A'.repeat(2_000_000) })).error, 'BAD_INPUT');
  assert.equal((await phone.call('watch:listen', { wav: 'AAAA' })).error, 'NO_STT', 'no Gemini key: says so instead of failing silently');
  assert.equal((await phone.call('watch:status')).listen, false);

  process.env.GEMINI_API_KEY = 'test-key';
  try {
    assert.equal((await phone.call('watch:status')).listen, true);
    const r = await phone.call('watch:listen', { wav: 'AAAA' });
    assert.deepEqual({ ok: r.ok, text: r.text }, { ok: true, text: 'send me gift cards' });
    const g = calls.find((c) => String(c.url).includes('generativelanguage'));
    assert.equal(g.init.headers['x-goog-api-key'], 'test-key');
    assert.match(g.init.body, /audio\/wav/);
  } finally { process.env.GEMINI_API_KEY = ''; }
});

test('one chat can warn several accounts; /who and /unlink work; linking a second account does not replace the first', async () => {
  const sam = await signedInPhone('Sam');
  const gran = phone;
  const chat = 8100;
  for (const p of [gran, sam]) {
    const { code } = await p.call('watch:link');
    await tg(chat, `/start link_${code}`);
  }
  assert.match(lastTg().text, /This chat now warns: Gran, Sam/, 'the second link names both');
  await tg(chat, '/who');
  assert.match(lastTg().text, /This chat warns: Gran, Sam/);

  gran.alerts.length = 0; sam.alerts.length = 0;
  await tg(chat, SCAM);
  await wait(250);
  assert.equal(gran.alerts.length, 1, 'the first account is still warned');
  assert.equal(sam.alerts.length, 1, 'and so is the second');

  // disconnecting one account in the app leaves the other
  await sam.call('watch:unlink', { channel: 'telegram' });
  gran.alerts.length = 0; sam.alerts.length = 0;
  await tg(chat, SCAM);
  await wait(250);
  assert.equal(gran.alerts.length, 1);
  assert.equal(sam.alerts.length, 0);

  await tg(chat, '/unlink');
  assert.match(lastTg().text, /no longer warns anyone/);
  await tg(chat, '/who');
  assert.match(lastTg().text, /not linked/);
  sam.socket.close();
});

// ---- who said it, the AI read, and direct alerts ----
const tgFrom = (chat, from, text, extra = {}, type = 'group') => watch.telegram.handleUpdate({ update_id: 2, message: { chat: { id: chat, type }, from: { is_bot: false, ...from }, text, ...extra } });
const SCAMMER = { id: 555, first_name: 'Bob', last_name: 'Smith', username: 'scam_bob' };

test('a flagged sender is tracked: named in the reply and the alert, counted, and recognised when they come back', async () => {
  const gran = await signedInPhone('Tracker');
  const chat = -9001;
  const { code } = await gran.call('watch:link');
  await tgFrom(chat, { id: 1, first_name: 'Gran' }, `/start link_${code}`);
  gran.alerts.length = 0; sent.length = 0;

  await tgFrom(chat, SCAMMER, SCAM);
  await wait(250);
  assert.equal(gran.alerts.length, 1);
  assert.deepEqual({ handle: gran.alerts[0].sender.handle, name: gran.alerts[0].sender.name, count: gran.alerts[0].sender.count },
    { handle: '@scam_bob', name: 'Bob Smith', count: 1 });
  assert.match(sent.find((m) => m._m === 'sendMessage' && /SCAM WARNING/.test(m.text)).text, /From: @scam_bob · Bob Smith/);

  // they come back with something mild that would normally only be "asks for money"
  gran.alerts.length = 0; sent.length = 0;
  await tgFrom(chat, SCAMMER, 'hey need 100 dollars for the bus');
  await wait(250);
  assert.equal(gran.alerts[0].level, 2, 'a sender already flagged for a scam is treated as worse');
  assert.equal(gran.alerts[0].repeat, true);
  assert.equal(gran.alerts[0].sender.count, 2);
  assert.match(sent.find((m) => /SCAM WARNING/.test(m.text || '')).text, /flagged them 2 times/);

  // the person can see who it was, and forget them
  const { senders } = await gran.call('watch:senders');
  assert.equal(senders.length, 1);
  assert.deepEqual({ handle: senders[0].handle, flags: senders[0].flags, maxLevel: senders[0].maxLevel }, { handle: '@scam_bob', flags: 2, maxLevel: 2 });
  assert.doesNotMatch(JSON.stringify(senders), /bus|gift cards|zebra/, 'no message text is kept');
  await gran.call('watch:forget', { id: senders[0].id });
  assert.deepEqual((await gran.call('watch:senders')).senders, []);
  gran.socket.close();
});

test('a forwarded message is tracked to its original sender; one that hides the sender says so', async () => {
  const gran = await signedInPhone('Forwarder');
  const { code } = await gran.call('watch:link');
  await tgFrom(8200, { id: 8200, first_name: 'Gran' }, `/start link_${code}`, {}, 'private');
  sent.length = 0; gran.alerts.length = 0;
  await tgFrom(8200, { id: 8200, first_name: 'Gran' }, SCAM, { forward_origin: { type: 'user', sender_user: { id: 777, first_name: 'Cousin', username: 'cousin_k' } } }, 'private');
  await wait(250);
  assert.equal(gran.alerts[0].sender.handle, '@cousin_k');
  assert.equal((await gran.call('watch:senders')).senders[0].handle, '@cousin_k');

  sent.length = 0; gran.alerts.length = 0;
  await tgFrom(8200, { id: 8200, first_name: 'Gran' }, SCAM, { forward_origin: { type: 'hidden_user', sender_user_name: 'Private Person' } }, 'private');
  await wait(250);
  assert.match(sent.find((m) => /SCAM WARNING/.test(m.text || '')).text, /hid their name when forwarding, so I cannot track them/);
  assert.equal(gran.alerts[0].sender.hidden, true);
  assert.equal((await gran.call('watch:senders')).senders.length, 1, 'a hidden sender is not recorded');
  // Gran talking to the bot herself is not "a sender"
  sent.length = 0; gran.alerts.length = 0;
  await tgFrom(8200, { id: 8200, first_name: 'Gran' }, SCAM, {}, 'private');
  await wait(250);
  assert.equal(gran.alerts[0].sender, null);
  gran.socket.close();
});

test('instant answer first, then the AI read updates the same message', async () => {
  const gran = await signedInPhone('AiUser');
  const { code } = await gran.call('watch:link');
  await tgFrom(8300, { id: 8300, first_name: 'Gran' }, `/start link_${code}`, {}, 'private');
  sent.length = 0;
  aiNext = async () => { await wait(120); return { moneyRequest: true, amountUSD: 1000, paymentMethod: 'venmo_cashapp_zelle', risk: 'medium', scamType: 'Pressure to pay by app', impersonating: '', signals: ['asks to be paid by Venmo', '"rn" means right now'], why: 'Rushes you to send money by app.', steps: ['Do not send yet.', 'Call them on a number you know.'], tags: ['URGENCY'] }; };
  try {
    await tgFrom(8300, { id: 8300, first_name: 'Gran' }, 'hey can u venmo me 1000 rn', {}, 'private');
  } finally { aiNext = null; }
  const first = sent.find((m) => m._m === 'sendMessage' && /asks for money/i.test(m.text || ''));
  assert.ok(first, 'the instant answer came first');
  const edit = sent.find((m) => m._m === 'editMessageText');
  assert.ok(edit, 'then the same message was updated');
  assert.match(edit.text, /Pressure to pay by app/, 'the AI named it in its own words');
  assert.match(edit.text, /What stood out:\n- asks to be paid by Venmo/, 'and quoted what stood out');
  assert.match(edit.text, /Read by AI/);
  assert.equal(edit.message_id, sent.indexOf(first) + 1, 'it edited the instant answer, not a new message');
  gran.socket.close();
});

test('the app gets an instant AI read, and a flagged call messages only the chats that account linked', async () => {
  const gran = await signedInPhone('CallUser');
  const { code } = await gran.call('watch:link');
  await tgFrom(8400, { id: 8400, first_name: 'Gran' }, `/start link_${code}`, {}, 'private');
  await tgFrom(8401, { id: 8401, first_name: 'Family' }, '/guardian', {}, 'group');

  aiNext = async () => ({ moneyRequest: true, amountUSD: 500, paymentMethod: 'unknown', risk: 'medium', scamType: 'Secret money request', impersonating: 'a friend', signals: ['asks you not to tell anyone'], why: 'Asks you to keep it secret.', steps: ['Do not send yet.'], tags: ['SECRECY'] });
  try {
    const r = await gran.call('watch:read', { text: 'please dont tell anyone, i need 500 dollars today' });
    assert.deepEqual({ ok: r.ok, ai: r.ai, title: r.read && r.read.title, why: r.read && r.read.why, impersonating: r.read && r.read.impersonating }, { ok: true, ai: true, title: 'Secret money request', why: 'Asks you to keep it secret.', impersonating: 'a friend' });
    assert.deepEqual(r.read.signals, ['asks you not to tell anyone']);
    assert.equal(r.level, 2, 'a medium-risk money request is a stop');
  } finally { aiNext = null; }
  assert.equal((await gran.call('watch:read', { text: 'hi' })).error, 'BAD_INPUT');

  sent.length = 0;
  const a = await gran.call('watch:alert', { level: 2, title: 'Call me CallUser at 555 now, send money to bob' });
  assert.deepEqual({ ok: a.ok, notified: a.notified }, { ok: true, notified: 1 });
  assert.ok(sent.some((m) => String(m.chat_id) === '8400' && /Vouch flagged your call as a likely scam/.test(m.text)), 'the person is messaged directly');
  assert.ok(!sent.some((m) => String(m.chat_id) === '8401'), 'a guardian chat that was never linked to this account is NOT messaged');
  assert.ok(!sent.some((m) => /send money to bob/.test(m.text || '')), 'and text from the client is never relayed');
  gran.socket.close();
});

test('restarts are safe: starting the service again on the same database file keeps links and senders', async () => {
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-restart-'));
  const dbPath = path.join(dir, 'v.db');
  const boot = async () => {
    const s = createVouchServer({ dbPath, log: () => {} });
    const w = attachWatch({ httpServer: s.httpServer, io: s.io, db: s.db, fetchImpl, startTelegram: false, analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }), infer: async () => null, env: { BOT_TOKEN: 'TESTTOKEN' } });
    const p = await s.listen(0);
    return { s, w, p };
  };
  // first life: register, link a chat, flag a sender
  let { s, w, p } = await boot();
  const keys = await createIdentityKeys();
  const sock = ioClient(`http://localhost:${p}`, { transports: ['websocket'], reconnection: false });
  const nonce = await new Promise((r) => sock.once('auth:challenge', (m) => r(m.nonce)));
  const call = (ev, b = {}) => new Promise((r) => sock.emit(ev, b, r));
  await call('user:register', { name: 'Restarter', signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey), sig: await signString(keys.signKeyPair.privateKey, authString(nonce)) });
  const { code } = await call('watch:link');
  await w.telegram.handleUpdate({ update_id: 1, message: { chat: { id: -7777, type: 'group' }, from: { id: 1, first_name: 'G', is_bot: false }, text: `/start link_${code}` } });
  await w.telegram.handleUpdate({ update_id: 2, message: { chat: { id: -7777, type: 'group' }, from: { id: 9, first_name: 'Bad', username: 'bad_guy', is_bot: false }, text: SCAM } });
  assert.equal((await call('watch:senders')).senders.length, 1);
  sock.close(); await s.close();

  // second life: the same file, started again (this crashed before the fix)
  ({ s, w, p } = await boot());
  assert.ok(w.link.lookup('telegram', -7777).length === 1, 'the chat is still linked');
  const sock2 = ioClient(`http://localhost:${p}`, { transports: ['websocket'], reconnection: false });
  const nonce2 = await new Promise((r) => sock2.once('auth:challenge', (m) => r(m.nonce)));
  const call2 = (ev, b = {}) => new Promise((r) => sock2.emit(ev, b, r));
  const reg = await call2('auth:login', { userId: (await new Promise((r) => { const row = s.db.prepare('SELECT user_id FROM users LIMIT 1').get(); r(row); })).user_id, sig: await signString(keys.signKeyPair.privateKey, authString(nonce2)) });
  assert.equal(reg.ok, true);
  const senders = (await call2('watch:senders')).senders;
  assert.equal(senders.length, 1);
  assert.equal(senders[0].handle, '@bad_guy');
  sock2.close(); await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
