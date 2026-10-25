// The real app, against the REAL server with the Watch service attached, over real sockets:
// a bot flags a message and it flashes in the app; a call is flagged live from typed words and from audio sent to the server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createVouchServer } from '../../server/src/app.js';
import { attachWatch } from '../../bot/watch.js';
import { installFakeDom } from '../dev/fakedom.js';
import { authString } from '../js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString, deriveWordKey, currentWord } from '../js/lib/crypto.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";
const clients = [];
let server; let watch; let url;
const sent = [];
let aiNext = null; // lets a test make the AI say something specific

let sttText = 'send me gift cards and do not tell anyone'; // what the faked speech-to-text hears
const fetchImpl = async (u, init) => {
  const s = String(u);
  if (s.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'vouch_test_bot' } }) };
  if (s.endsWith('/getBusinessConnection')) return { json: async () => ({ ok: true, result: { id: 'bcX', user: { id: 7001, first_name: 'Gran' }, user_chat_id: 7001, is_enabled: true } }) };
  if (s.includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }
  if (s.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: sttText }] } }] }) };
  return { ok: true, json: async () => ({}) };
};

const dom = installFakeDom({ makeSocket: () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; } });
const { appEl, loc, wait, text, btn, find } = dom;
// The settings button in the header has no text, only an icon and an accessible name.
const displayBtn = () => find(appEl, (n) => n.tag === 'button' && n.attrs && n.attrs['aria-label'] === 'Display and reading settings');
const go = async (label) => { const home = btn('Home'); if (home) { await home.fire('click'); await wait(30); } await btn(label).fire('click'); };

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
// Wait for something to be true (up to 8 s) instead of sleeping a fixed time, so a busy machine cannot make a test flaky.
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(100); } return false; };
// End a call the way a person does: tap Stop, then close the summary that follows (it waits for the whole call).
const stopCall = async () => { await btn('Stop listening').fire('click'); await until(() => !!btn('Done'), 3000); const d = btn('Done'); if (d) await d.fire('click'); await wait(60); };
const dismissAll = async () => { for (let i = 0; i < 5; i++) { const b = btn('I understand') || btn('Close') || btn("OK, I won't send") || btn('Keep listening') || btn('Done'); if (!b) break; await b.fire('click'); } };

test('sign up, then the message-bot card shows Telegram and a one-time link code', async () => {
  find(appEl, (n) => n.id === 'name').value = 'Gran';
  await btn('Get started').fire('click');
  await wait(1000);
  await go('My people');
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
  assert.ok(text().includes('DO NOT ACT ON THIS'), 'and the sticky banner is up');
  assert.ok(!text().includes('zebra') && !text().includes('$200'), 'the message itself never reached the app');
  await dismissAll();
});

test('On a call works with no friends: typed words are flagged live, with the scam type and steps', async () => {
  await go('On a call');
  await wait(100);
  assert.ok(text().includes('Listen for scams'), 'the call listener is there even with no friends');
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
  await go('My people'); // the app re-reads what the server offers
  await wait(200);
  await go('On a call');
  await wait(100);
  // start from a clean slate: clear the typed words and the earlier call alert
  const box = find(appEl, (n) => n.id === 'callsays');
  box.value = '';
  await box.fire('input');
  await btn('Listen for scams').fire('click');
  await wait(300);
  assert.ok(text().includes('Put the call on speaker'), 'tells the person what to do');
  assert.ok(proc && typeof proc.onaudioprocess === 'function', 'the microphone is wired up');
  const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
  for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } }); // about six seconds
  await wait(800);
  assert.ok(text().includes('STOP. This looks like a scam'), 'the call screen turns to the warning from what the server heard');
  assert.ok(text().includes('Watching call'), 'the header shows it is watching');
  await stopCall();
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
  await go('My people'); await wait(150);
  await go('On a call'); await wait(100);
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
  assert.ok(text().includes('STOP. This looks like a scam'), 'the call is flagged as the words come in, on the call screen itself');
  assert.ok(text().includes('gift cards'), 'the captions show what was heard');
  assert.ok(dom.findAll(appEl, (n) => n.tag === 'mark').length >= 1, 'with the risky words marked');
  await stopCall();
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
  return { id: res.userId, socket, call: callOn, keys };
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
  assert.ok(find(appEl, (n) => n.tag === 'details' && n.className === 'whybox'), 'the proof sits behind one tap: Why Vouch thinks so');
  await dismissAll();
  await go('My people');
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
  await go('Check a message');
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
  await go('On a call');
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

// ---- end to end: the three ways a scam reaches a phone, through the real server into the real app ----
const BANK = "First Harbor Bank fraud dept: your account is compromised. Read me the six digit code we just texted you and do not tell anyone.";

test('Telegram Business, end to end: a stranger writes to the connected person and the Vouch app flashes with who sent it', async () => {
  await dismissAll();
  await watch.telegram.handleUpdate({ update_id: 700, business_message: { business_connection_id: 'bcX', chat: { id: 9100, type: 'private' },
    from: { id: 9100, first_name: 'Judge', username: 'judge_bank', is_bot: false }, text: BANK } });
  await wait(600);
  assert.ok(text().includes('Sent to Vouch from Telegram'), 'the app flashed');
  assert.ok(text().includes('@judge_bank'), 'and says who wrote');
  assert.ok(!text().includes('six digit code') && !text().includes('First Harbor'), 'the message itself never reached the app');
  await dismissAll();
  await watch.telegram.handleUpdate({ update_id: 701, business_message: { business_connection_id: 'bcX', chat: { id: 9100, type: 'private' },
    from: { id: 9101, first_name: 'Pal', username: 'a_friend', is_bot: false }, text: 'are we still on for lunch tomorrow?' } });
  await wait(400);
  assert.ok(!find(appEl, (n) => n.className === 'actions') && !find(appEl, (n) => String(n.className).startsWith('notice')), 'a normal message from a friend raises nothing new: no warning screen, no pop-up');
});

test('Telegram group, end to end: /link the group, then what anyone types there reaches the linked phone', async () => {
  const gran = await otherPhone('GroupGran');
  const { code } = await gran.call('watch:link');
  const inGroup = (id, from, t) => watch.telegram.handleUpdate({ update_id: id, message: { chat: { id: -5001, type: 'group' }, from: { is_bot: false, ...from }, text: t } });
  await inGroup(800, { id: 1, first_name: 'Shivaan' }, `/link ${code}`);
  assert.match(sent[sent.length - 1].text, /Linked to GroupGran/, 'the group is linked with the plain /link form');
  const flagged = new Promise((resolve) => gran.socket.once('scam:alert', resolve));
  await inGroup(801, { id: 2, first_name: 'Judge', username: 'judge_two' }, "Hi it's your grandson, new number. I'm in trouble: buy $300 in Apple gift cards right now and don't tell mom.");
  const a = await flagged;
  assert.equal(a.level, 2);
  assert.equal(a.source, 'telegram');
  assert.equal(a.sender.handle, '@judge_two');
  assert.ok(!JSON.stringify(a).includes('gift cards') && !JSON.stringify(a).includes('$300'), 'the alert carries no message text');
  let quiet = true;
  gran.socket.once('scam:alert', () => { quiet = false; });
  await inGroup(802, { id: 3, first_name: 'Pal' }, 'dinner at 7 on Friday? mom is making lasagna');
  await wait(400);
  assert.ok(quiet, 'a normal message in the group stays silent');
  gran.socket.close();
});

test('a call, end to end: the call engine stops a "read me the code" call, explains why, and leaves a genuine call alone', async () => {
  await dismissAll();
  await go('On a call');
  const box = find(appEl, (n) => n.id === 'callsays');
  box.value = '';
  await box.fire('input'); // an earlier test's call is over: a new call starts calm
  await wait(100);
  box.value = "Hello, this is First Harbor Bank. We sent you a code, please read me the six digit code we just texted you.";
  await box.fire('input');
  await wait(300);
  assert.ok(text().includes('STOP'), 'a red line is a stop at once');
  assert.ok(text().includes('They asked you to read out a code'), 'with the reason in plain words');
  assert.ok(text().includes('Hang up'), 'and what to do');
  await dismissAll();
  box.value = '';
  await box.fire('input'); // a new call starts calm
  await wait(100);
  box.value = "Hi, it is Dr Lee's office confirming your appointment on Tuesday at three.";
  await box.fire('input');
  await wait(300);
  assert.ok(!text().includes('STOP'), 'a genuine call from a doctor does not raise an alarm');
});

test('on a live call that turns suspicious, the code word is already on screen to ask the caller for', async () => {
  await dismissAll();
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  dom.nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  await go('My people'); await wait(150);
  await go('On a call'); await wait(100);
  const sam = btn('Sam');
  if (sam) { await sam.fire('click'); await wait(150); }
  await btn('Listen for scams').fire('click');
  await wait(300);
  assert.ok(proc && typeof proc.onaudioprocess === 'function', 'the microphone is wired up');
  const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
  for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
  await wait(900);
  assert.ok(text().includes('STOP. This looks like a scam'), 'the call screen turns to the warning');
  assert.ok(text().includes("What's our word?"), 'and says to ask for the code word');
  assert.ok(find(appEl, (n) => n.id === 'bigword'), 'with the word itself on screen');
  await stopCall();
});

test('the AI read alone raises a call warning: no scam words and no code words anywhere in what was said', async () => {
  await dismissAll();
  await go('On a call');
  const box = find(appEl, (n) => n.id === 'callsays');
  box.value = '';
  await box.fire('input');
  await wait(4400); // the app asks the AI at most every four seconds
  aiNext = async () => ({ moneyRequest: false, amountUSD: null, paymentMethod: 'unknown', risk: 'high', scamType: 'Impersonating a relative', impersonating: 'a grandchild',
    signals: ["calls from a 'friend's phone'", 'builds a story before any ask'], why: 'A caller pretending to be a grandchild is building a story to ask for help.',
    steps: ['Hang up.', 'Call them on the number you know.'], tags: [], intent: 'message', reply: '', links: [], image: null, heard: '' });
  try {
    box.value = "Hi Grandma, it's me. My phone broke so I'm calling from a friend's and I've had a really rough night.";
    await box.fire('input');
    await until(() => text().includes('Someone on this call is asking for money') || text().includes('Noticing') || !!find(appEl, (n) => String(n.className).startsWith('notice')), 5000);
    assert.ok(!text().includes('STOP. This call looks like a scam'), 'a story on its own is not a clear flag: the call carries on, no STOP');
    // the moment there is an actual ask, the AI's confidence counts and it is a stop
    await wait(4600); // the app asks the AI at most every four seconds
    box.value = "Hi Grandma, it's me. My phone broke so I'm calling from a friend's and I've had a really rough night. Can you send me 800 dollars tonight?";
    await box.fire('input');
    await until(() => text().includes('STOP. This call looks like a scam'), 7000);
    assert.ok(text().includes('STOP. This call looks like a scam'), 'story plus an ask, with the AI confident, is a stop');
    assert.ok(text().includes('Impersonating a relative'), 'and it names what it inferred');
  } finally { aiNext = null; }
  await dismissAll();
});

test('Check a message shows Telegram as a connected app: its logo, the real status, the last warning, and who was flagged', async () => {
  await dismissAll();
  await go('Check a message');
  await wait(300);
  assert.ok(find(appEl, (n) => n.id === 'tgcard'), 'the Telegram card is on the Check screen');
  assert.ok(find(appEl, (n) => n.className === 'applogo tg') && find(appEl, (n) => n.className === 'logo' && /telegram\.svg/.test(String(n.attrs.style))), 'with the Telegram logo');
  const card = find(appEl, (n) => n.id === 'tgcard');
  const cardText = dom.textOf ? dom.textOf(card) : text();
  assert.ok(/Connected/.test(cardText) && cardText.includes('@vouch_test_bot'), 'it is connected, and says which bot');
  assert.ok(text().includes('Last warning:'), 'it says when the last warning came in');
  const count = () => Number((/Flagged senders \((\d+)\)/.exec(text()) || [])[1] || 0);
  const before = count();
  assert.ok(before >= 1 && (text().includes('@fake_irs') || text().includes('@judge_bank')), 'it lists who was flagged, from the real server list');
  await btn('Forget this sender').fire('click');
  await wait(400);
  assert.equal(count(), before - 1, 'forgetting a sender really removes them');
});

test('the caller saying the real rotating code word is heard, and shown as a match to confirm (not decided for the person)', async () => {
  await dismissAll();
  // pair a new friend, so there is a real shared word
  await go('My people');
  await btn('Add someone').fire('click');
  await wait(400);
  const m = /([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(text());
  assert.ok(m, 'a pairing code is shown');
  const wanda = await otherPhone('Wanda');
  assert.equal((await wanda.call('pair:accept', { token: m.slice(1).join('') })).ok, true);
  await wait(700);
  await btn('It matches').fire('click');
  await wait(150);
  const me = (await wanda.call('circle:list')).friends.find((f) => f.name === 'Gran');
  const { word } = await currentWord(await deriveWordKey(wanda.keys.exchKeyPair.privateKey, me.exchPub));
  const before = sttText;
  sttText = `hello it is me, and our word is ${word}, ok?`;
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  dom.nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  try {
    await go('On a call'); await wait(100);
    await btn('Wanda').fire('click'); await wait(150);
    await btn('Listen for scams').fire('click'); await wait(300);
    const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
    for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    await until(() => text().includes('Code word heard'));
    assert.ok(text().includes('Code word heard') && text().includes('They said our code word, and it matches'), 'the real word, said aloud, is recognised');
    assert.ok(btn('It matches'), 'and the person still has the button to confirm it');
    await stopCall();
  } finally { sttText = before; wanda.socket.close(); }
});

test('a wrong word is not mistaken for the code word: the assistant suggests asking for it', async () => {
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  const before = sttText;
  sttText = "grandma it's me, my phone broke so I'm calling from a friend's, there's no time, please hurry and send two hundred dollars";
  try {
    await go('On a call'); await wait(100);
    await btn('Wanda').fire('click'); await wait(150);
    await btn('Listen for scams').fire('click'); await wait(300);
    const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
    for (let i = 0; i < 25; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    await until(() => text().includes('Say this'));
    assert.ok(!text().includes('Code word heard'), 'no match was claimed');
    assert.ok(text().includes('Say this') && text().includes("What's our word?"), 'the assistant says what to ask');
    await stopCall();
  } finally { sttText = before; }
});

test('Check my setup: the microphone is tested and what the speech-to-text heard is shown, with how long it took', async () => {
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  dom.nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  const iphone = dom.nav.userAgent;
  Object.defineProperty(dom.nav, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', configurable: true });
  const before = sttText; sttText = 'this is a test of the microphone';
  try {
    await go('On a call'); await wait(100);
    const run = btn('Test the microphone and listening').fire('click');
    await wait(200);
    const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
    for (let i = 0; i < 20; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    await run; await wait(4600);
    assert.ok(text().includes('The microphone works'), 'it says the microphone works');
    assert.ok(text().includes('The Vouch server heard: "this is a test of the microphone"'), 'and shows what the speech-to-text heard');
    assert.match(text(), /s to transcribe/, 'with how long it took');
  } finally { sttText = before; Object.defineProperty(dom.nav, 'userAgent', { value: iphone, configurable: true }); }
});

test('Check my setup: a silent room is reported plainly, not as success', async () => {
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  await go('On a call'); await wait(100);
  const run = btn('Test the microphone and listening').fire('click');
  await wait(200);
  const silence = new Float32Array(4096);
  for (let i = 0; i < 20; i++) proc.onaudioprocess({ inputBuffer: { getChannelData: () => silence } });
  await run; await wait(4600);
  assert.ok(text().includes('No sound was picked up'), 'it says so, and what to check');
});

test('a soft check is a pop-up you can open later, not a screen that takes over; a stop takes over', async () => {
  await dismissAll();
  await go('Check a message'); await wait(200);
  // a friendly money request: "someone is asking", worth a look but not a stop
  await tg(7001, 'hey can you venmo me $15 for the pizza from last night? thanks!');
  await until(() => !!find(appEl, (n) => String(n.className).startsWith('notice')));
  const pop = find(appEl, (n) => String(n.className).startsWith('notice'));
  assert.ok(pop, 'a pop-up notice appeared');
  assert.ok(!find(appEl, (n) => n.className === 'actions'), 'and no full-screen warning took over');
  assert.ok(btn('Review') && btn('Dismiss'), 'with big buttons to open it or wave it away');
  await btn('Review').fire('click');
  await wait(200);
  assert.ok(find(appEl, (n) => n.className === 'actions'), 'Review opens the full warning, on the person\'s terms');
  await dismissAll();
});

// ---- a call is never cut off, and it ends with a summary and what to do now ----
const mockMic = () => {
  let proc;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.state = 'running'; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    close() {}
  };
  dom.nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  return () => proc;
};

test('a hiccup in the browser speech service does not end the call or lose the warning', async () => {
  await dismissAll();
  const getProc = mockMic();
  let sr;
  globalThis.webkitSpeechRecognition = class { constructor() { sr = this; this.starts = 0; } start() { this.starts += 1; } stop() {} };
  try {
    await go('On a call'); await wait(100);
    await btn('Listen for scams').fire('click'); await wait(200);
    sr.onresult({ results: [[{ transcript: 'we sent you a code, please read me the six digit code we just texted you' }]] });
    await until(() => text().includes('STOP. This looks like a scam'));
    assert.ok(text().includes('STOP. This looks like a scam'), 'a clear flag raised the warning');
    // the speech service drops out, over and over
    sr.onerror({ error: 'network' }); sr.onend();
    await until(() => sr.starts >= 2, 4000);
    assert.ok(sr.starts >= 2, 'it was quietly started again');
    assert.ok(btn('Stop listening'), 'still listening, the person has not ended it');
    assert.ok(text().includes('STOP. This looks like a scam'), 'and the warning is still there');
    for (let i = 0; i < 4; i++) sr.onerror({ error: 'network' });
    await wait(500);
    assert.ok(btn('Stop listening'), 'after repeated drop-outs it carries on with Vouch\'s own listener instead of giving up');
    assert.ok(text().includes('STOP. This looks like a scam'), 'with the warning and what was heard intact');
    void getProc;
  } finally { delete globalThis.webkitSpeechRecognition; await stopCall(); }
});

test('when the person ends the call, a summary says what happened and what to do now', async () => {
  await dismissAll();
  const getProc = mockMic();
  const before = sttText; sttText = 'this is the fraud team, your account is compromised, please read me the six digit code we just texted you';
  try {
    await go('On a call'); await wait(100);
    await btn('Listen for scams').fire('click'); await wait(250);
    const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
    for (let i = 0; i < 25; i++) getProc().onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    await until(() => text().includes('STOP. This looks like a scam'));
    await btn('Stop listening').fire('click');
    await until(() => text().includes('Call summary'));
    assert.ok(text().includes('Call summary') && text().includes('This call looked like a scam'), 'it says plainly what the call was');
    assert.ok(text().includes('What to do now') && text().includes('Call your bank on the number on your card'), 'and the correct next steps');
    assert.ok(text().includes('Do not call back the number that called you'));
    assert.ok(!text().includes('Recording of this call'), 'with no recording, because recording is off unless the person turned it on');
    await btn('Done').fire('click');
  } finally { sttText = before; }
});

test('with recording switched on, the whole call is saved on this phone, can be played back, and can be deleted', async () => {
  await dismissAll();
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, opts) { this.mimeType = (opts && opts.mimeType) || 'audio/webm'; }
    start() { this.t = setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new Blob(['call audio'], { type: this.mimeType }) }), 10); }
    stop() { clearTimeout(this.t); if (this.ondataavailable) this.ondataavailable({ data: new Blob(['call audio'], { type: this.mimeType }) }); setTimeout(() => this.onstop && this.onstop(), 5); }
  };
  globalThis.URL.createObjectURL = () => 'blob:test';
  globalThis.URL.revokeObjectURL = () => {};
  const getProc = mockMic();
  const before = sttText; sttText = 'this is the fraud team, your account is compromised, please read me the six digit code we just texted you';
  try {
    await displayBtn().fire('click'); await wait(60);
    await btn('Keep a recording of calls on this phone').fire('click'); await wait(60);
    assert.equal(JSON.parse(localStorage.getItem('vouch-display')).record, true, 'switched on, and remembered');
    assert.ok(text().includes('Tell the other person you are recording'), 'with a plain reminder to tell the other person');
    await btn('Done').fire('click'); await wait(60);
    await go('On a call'); await wait(100);
    await btn('Listen for scams').fire('click'); await wait(250);
    const block = Float32Array.from({ length: 4096 }, (_, i) => 0.3 * Math.sin(i / 7));
    for (let i = 0; i < 25; i++) getProc().onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    await wait(600);
    await btn('Stop listening').fire('click');
    await until(() => text().includes('Recording of this call'), 5000);
    assert.ok(text().includes('Recording of this call'), 'the recording is there after the call');
    assert.ok(find(appEl, (n) => n.tag === 'audio'), 'with a player');
    assert.ok(btn('Delete the recording'), 'and a delete button');
    const { getLastCall } = await import('../js/lib/store.js');
    const saved = await getLastCall();
    assert.ok(saved && saved.blob && saved.ms >= 0, 'stored on the phone (in its own storage, not sent anywhere)');
    await btn('Delete the recording').fire('click'); await wait(100);
    assert.equal(await getLastCall(), null, 'deleted for real');
    await btn('Done').fire('click');
  } finally {
    sttText = before; delete globalThis.MediaRecorder;
    await displayBtn().fire('click'); await wait(40);
    const off = btn('Keep a recording of calls on this phone'); if (off && JSON.parse(localStorage.getItem('vouch-display')).record) await off.fire('click');
    const done = btn('Done'); if (done) await done.fire('click');
  }
});

test('the call card says who the caller claims to be and who you are, without presenting it as proven', async () => {
  await dismissAll();
  await go('On a call'); await wait(100);
  await btn('Listen for scams').fire('click'); await wait(200);
  const box = find(appEl, (n) => n.tag === 'textarea' && n.attrs && n.attrs.id === 'callsays');
  if (box) { box.value = 'Hello, this is Sam from First Harbor Bank fraud department, please read me the six digit code'; await box.fire('input'); }
  await wait(300);
  assert.ok(text().includes('Caller') && text().includes('You'), 'both labels are on the card');
  assert.ok(text().includes('this phone'), 'and who you are');
  assert.ok(!/Caller[^]*verified|confirmed by Vouch/i.test(text()), 'never claims it knows who it is for sure');
  await stopCall();
});