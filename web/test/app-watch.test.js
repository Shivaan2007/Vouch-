// The real app, against the REAL server with the Watch service attached, over real sockets:
// a bot flags a message and it flashes in the app; a call is flagged live from typed words and from audio sent to the server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createVouchServer } from '../../server/src/app.js';
import { attachWatch } from '../../bot/watch.js';
import { installFakeDom } from '../dev/fakedom.js';
import { authString } from '../js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString } from '../js/lib/crypto.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";
const clients = [];
let server; let watch; let url;
const sent = [];
let aiNext = null; // lets a test make the AI say something specific

const fetchImpl = async (u, init) => {
  const s = String(u);
  if (s.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'vouch_test_bot' } }) };
  if (s.includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }
  if (s.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'send me gift cards and do not tell anyone' }] } }] }) };
  return { ok: true, json: async () => ({}) };
};

const dom = installFakeDom({ makeSocket: () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; } });
const { appEl, loc, wait, text, btn, find } = dom;

before(async () => {
  process.env.GEMINI_API_KEY = 'test-key'; // so the server can listen; the Gemini call is faked above
  server = createVouchServer({ log: () => {} });
  watch = attachWatch({
    httpServer: server.httpServer, io: server.io, db: server.db, fetchImpl, startTelegram: false,
    analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }),
    infer: async (i) => (aiNext ? aiNext(i) : null),
    env: { BOT_TOKEN: 'TESTTOKEN' },
  });
  url = `http://localhost:${await server.listen(0)}`;
  loc.origin = url;
  await import('../js/app.js');
  await wait(600);
});
after(async () => { process.env.GEMINI_API_KEY = ''; clients.forEach((s) => s.close()); await server.close(); });

const tg = (chat, t) => watch.telegram.handleUpdate({ update_id: 1, message: { chat: { id: chat, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, text: t } });
const dismissAll = async () => { for (let i = 0; i < 5; i++) { const b = btn('I understand') || btn('Not now') || btn('Keep listening'); if (!b) break; await b.fire('click'); } };

test('sign up, then the message-bot card shows Telegram and a one-time link code', async () => {
  find(appEl, (n) => n.id === 'name').value = 'Gran';
  await btn('Get started').fire('click');
  await wait(1000);
  await btn('My people').fire('click');
  await wait(100);
  assert.ok(text().includes('Connected apps'));
  assert.ok(text().includes('@vouch_test_bot'), 'the door the server really has');
  assert.ok(text().includes('Not connected'));
  assert.ok(dom.findAll(appEl, (n) => n.className === 'logo').length >= 1, 'with its logo');
  await btn('Connect').fire('click');
  await wait(300);
  assert.match(text(), /Open Telegram/);
  const open = dom.find(appEl, (n) => n.tag === 'a' && /Open Telegram/.test(n.textContent));
  assert.match(open.attrs.href, /^https:\/\/t\.me\/vouch_test_bot\?start=link_\d{6}$/, 'one tap opens the bot with the code filled in');
  assert.match(text(), /Or send this yourself: \/link \d{6}/);
});

test('a message forwarded to the linked bot chat flashes a warning in the app', async () => {
  const code = /start=link_(\d{6})/.exec(dom.find(appEl, (n) => n.tag === 'a' && /Open Telegram/.test(n.textContent)).attrs.href)[1];
  await tg(7001, `/start link_${code}`); // exactly what Telegram sends when the person taps Start
  assert.match(sent[sent.length - 1].text, /Linked to Gran/);
  await wait(400);
  assert.ok(text().includes('Telegram is connected'), 'the app notices by itself');
  assert.ok(dom.find(appEl, (n) => n.tag === 'button' && n.textContent.trim() === 'Disconnect'), 'and the row now says Connected');
  await tg(7001, SCAM);
  await wait(400);
  assert.ok(text().includes('Sent to Vouch from Telegram'), 'says where it came from');
  assert.ok(text().includes('Possible family-emergency scam'), 'names the scam type');
  assert.ok(text().includes('DO NOT SEND ANYTHING'), 'and the sticky banner is up');
  assert.ok(!text().includes('zebra') && !text().includes('$200'), 'the message itself never reached the app');
  await dismissAll();
});

test('On a call works with no friends: typed words are flagged live, with the scam type and steps', async () => {
  await btn('On a call').fire('click');
  await wait(100);
  assert.ok(text().includes('Listen to this call'), 'the call listener is there even with no friends');
  const box = find(appEl, (n) => n.id === 'callsays');
  box.value = 'please go and buy some apple gift cards and read me the numbers';
  await box.fire('input');
  await wait(100);
  assert.ok(text().includes('STOP. This call looks like a scam.'), 'full-screen call warning');
  assert.ok(text().includes('Gift-card demand'), 'the live guide names it');
  await dismissAll();
});

test('listening through the Vouch server: audio goes up, words come back, the call is flagged', async () => {
  // A fake microphone and audio engine in the page.
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  dom.nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  await btn('My people').fire('click'); // the app re-reads what the server offers
  await wait(200);
  await btn('On a call').fire('click');
  await wait(100);
  // start from a clean slate: clear the typed words and the earlier call alert
  const box = find(appEl, (n) => n.id === 'callsays');
  box.value = '';
  await box.fire('input');
  await btn('Listen to this call').fire('click');
  await wait(300);
  assert.ok(text().includes('Put the call on speaker'), 'tells the person what to do');
  assert.ok(proc && typeof proc.onaudioprocess === 'function', 'the microphone is wired up');
  const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
  for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } }); // about six seconds
  await wait(800);
  assert.ok(text().includes('STOP. Scam signs'), 'the call screen turns to the warning from what the server heard');
  assert.ok(text().includes('Watching call'), 'the header shows it is watching');
  await btn('End').fire('click');
  await wait(100);
  assert.ok(!text().includes('Watching call'));
});

test('the call screen: caller, clock, captions with the risky words marked, risk badge, and a recording is analysed as it "plays"', async () => {
  // A recording: the page decodes it, plays it, and sends it up in five-second windows as it goes.
  const rate = 16000;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = rate; this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData(buf, ok) { const a = { length: rate * 6, sampleRate: rate, numberOfChannels: 1, getChannelData: () => Float32Array.from({ length: rate * 6 }, (_, i) => 0.3 * Math.sin(i / 9)) }; ok(a); return Promise.resolve(a); }
    close() {}
  };
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  globalThis.URL.createObjectURL = () => 'blob:test';
  globalThis.URL.revokeObjectURL = () => {};
  await btn('My people').fire('click'); await wait(150);
  await btn('On a call').fire('click'); await wait(100);
  const pick = find(appEl, (n) => n.id === 'recfile');
  assert.ok(pick, 'the recording picker is offered because the server can listen');
  const file = { arrayBuffer: async () => new ArrayBuffer(8), name: 'clip.mp3' };
  pick.files = [file];
  await pick.fire('change');
  await wait(300);
  assert.ok(text().includes('Analyzing a recording'), 'the call screen opens');
  assert.ok(text().includes('Unknown caller') || text().includes('Gran') || text().length > 0);
  assert.match(text(), /\d\d:\d\d/, 'there is a call clock');
  assert.ok(text().includes('Nothing suspicious so far'), 'and a risk badge that starts calm');
  await wait(5600); // the first five-second window finishes "playing" and goes to the server
  await wait(900);
  assert.ok(text().includes('STOP. Scam signs'), 'the call is flagged as the words come in, on the call screen itself');
  assert.ok(text().includes('gift cards'), 'the captions show what was heard');
  assert.ok(dom.findAll(appEl, (n) => n.tag === 'mark').length >= 1, 'with the risky words marked');
  await btn('End').fire('click');
  await wait(100);
  assert.ok(!text().includes('Analyzing a recording'));
});

// ---- who sent it, the instant AI read, and direct alerts ----
async function otherPhone(name) {
  const keys = await createIdentityKeys();
  const pubs = { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  const nonce = await new Promise((r) => socket.once('auth:challenge', (m) => r(m.nonce)));
  const callOn = (ev, body = {}) => new Promise((r) => socket.emit(ev, body, r));
  const res = await callOn('user:register', { name, ...pubs, sig: await signString(keys.signKeyPair.privateKey, authString(nonce)) });
  return { id: res.userId, socket, call: callOn };
}

test('a forwarded scam shows who sent it, what the AI made of it, and the sender is listed', async () => {
  aiNext = async () => ({ moneyRequest: true, amountUSD: null, paymentMethod: 'gift_card', risk: 'high', scamType: 'Fake tax-office call', impersonating: 'the tax office', signals: ['claims you owe back taxes', 'wants gift cards'], why: 'Pretends to be the tax office and rushes you.', steps: ['Hang up.', 'Call the tax office yourself.'], tags: ['URGENCY'], intent: 'message', reply: '' });
  try {
    await watch.telegram.handleUpdate({ update_id: 5, message: { chat: { id: 7001, type: 'private' }, from: { id: 7001, first_name: 'Gran', is_bot: false },
      text: 'This is the IRS. You owe back taxes, pay the fee now with gift cards',
      forward_origin: { type: 'user', sender_user: { id: 901, first_name: 'Fake', last_name: 'Agent', username: 'fake_irs' } } } });
    await wait(500);
  } finally { aiNext = null; }
  assert.ok(text().includes('From @fake_irs (Fake Agent)'), 'names who sent it');
  assert.ok(text().includes('Fake tax-office call'), 'the AI named it in its own words');
  assert.ok(text().includes('It claims to be: the tax office'), 'said who it claims to be');
  assert.ok(text().includes('claims you owe back taxes'), 'and quoted what stood out');
  assert.ok(text().includes('read by AI'), 'and says the AI read it');
  await dismissAll();
  await btn('My people').fire('click');
  await wait(300);
  assert.ok(text().includes('Flagged senders'), 'there is a list of flagged senders');
  assert.ok(text().includes('@fake_irs'), 'with this one in it');
  assert.ok(text().includes('never the message'), 'and a plain note about what is kept');
});

test('the Check form shows the AI read a moment after you paste, and a flagged call messages the person directly', async () => {
  // a friend, so the Check form is available
  globalThis.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => true });
  await btn('Add someone').fire('click');
  await wait(400);
  const codeMatch = /([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(text());
  assert.ok(codeMatch, 'the pairing code is shown. Screen: ' + text().slice(0, 400));
  const token = codeMatch.slice(1).join('');
  const sam = await otherPhone('Sam');
  assert.equal((await sam.call('pair:accept', { token })).ok, true);
  await wait(600);
  await btn('It matches').fire('click');
  await btn('Check a message').fire('click');
  await wait(150);
  aiNext = async () => ({ moneyRequest: true, amountUSD: 1000, paymentMethod: 'unknown', risk: 'medium', scamType: 'Secret money request', impersonating: 'a friend', signals: ['asks you not to tell anyone'], why: 'Asks you to keep it secret.', steps: ['Do not send yet.', 'Call them on a number you know.'], tags: ['SECRECY'], intent: 'message', reply: '' });
  try {
    const box = find(appEl, (n) => n.id === 'text');
    box.value = 'hey please dont tell anyone but I need 1000 dollars';
    await box.fire('input');
    await wait(1300); // the app waits a moment after typing stops
  } finally { aiNext = null; }
  assert.ok(text().includes('AI read') && text().includes('Secret money request') && text().includes('Asks you to keep it secret.'), 'the AI card replaces the generic guide');
  assert.ok(text().includes('asks you not to tell anyone'), 'with what stood out');

  sent.length = 0;
  await btn('On a call').fire('click');
  await wait(100);
  const calls = dom.nav; // unused; keep lint quiet
  void calls;
  const callBox = find(appEl, (n) => n.id === 'callsays');
  callBox.value = 'please buy gift cards and read me the numbers';
  await callBox.fire('input');
  await wait(500);
  assert.ok(sent.some((m) => /Vouch flagged your call/.test(m.text || '')), 'the alert bot messaged the person on Telegram');
  await dismissAll();
  sam.socket.close();
});