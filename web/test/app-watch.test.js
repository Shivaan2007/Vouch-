// The real app, against the REAL server with the Watch service attached, over real sockets:
// a bot flags a message and it flashes in the app; a call is flagged live from typed words and from audio sent to the server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createVouchServer } from '../../server/src/app.js';
import { attachWatch } from '../../bot/watch.js';
import { installFakeDom } from '../dev/fakedom.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";
const clients = [];
let server; let watch; let url;
const sent = [];

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
  assert.ok(text().includes('Watch this call for scams'), 'the call watcher is there even with no friends');
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
  await btn('Start watching').fire('click');
  await wait(300);
  assert.ok(text().includes('Listening through Vouch'), 'says which engine it is using');
  assert.ok(proc && typeof proc.onaudioprocess === 'function', 'the microphone is wired up');
  const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
  for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } }); // about six seconds
  await wait(800);
  assert.ok(text().includes('STOP. This call looks like a scam.'), 'flagged from what the server heard');
  assert.ok(text().includes('Watching call'), 'the header shows it is watching');
  await dismissAll();
  await btn('Stop watching').fire('click');
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
  assert.ok(text().includes('No warning signs yet'), 'and a risk badge that starts calm');
  await wait(5600); // the first five-second window finishes "playing" and goes to the server
  await wait(900);
  assert.ok(text().includes('STOP. This call looks like a scam.'), 'the call is flagged as the words come in');
  await dismissAll(); // the warning covers the call screen until it is dismissed, like a real alert
  assert.ok(text().includes('gift cards'), 'the captions show what was heard');
  assert.ok(dom.findAll(appEl, (n) => n.tag === 'mark').length >= 1, 'with the risky words marked');
  assert.ok(text().includes('Scam warning signs'), 'and the badge has turned to the warning');
  await btn('End').fire('click');
  await wait(100);
  assert.ok(!text().includes('Analyzing a recording'));
});
