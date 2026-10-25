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
let server; let watch; let url; let phone;
const PUBLIC = 'https://example.test';

// A fake outside world: Telegram, Twilio and Gemini.
const fetchImpl = async (u, init) => {
  const s = String(u);
  calls.push({ url: s, init });
  if (s.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'vouch_test_bot' } }) };
  if (s.includes('api.telegram.org') && s.endsWith('/sendMessage')) { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }
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
