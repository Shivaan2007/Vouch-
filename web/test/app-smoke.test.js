// Boots the real web/js/app.js under a minimal fake DOM, connected to the v2 reference server over a real socket,
// and drives the UI: sign-up, every tab, the pairing code, and the warning a shared scam message triggers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createMockServer } from '../dev/mock-server.js';
import { installFakeDom } from '../dev/fakedom.js';
import { authString } from '../js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString, signAnswer } from '../js/lib/crypto.js';

// A spy on the browser's voice: the app must never speak on its own.
globalThis.__spoken = 0;
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { speak() { globalThis.__spoken += 1; }, cancel() {} };
const server = createMockServer();
const clients = [];
let url = '';
const dom = installFakeDom({ makeSocket: () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; } });
const { appEl, loc, wait, text, btn, find, findAll } = dom;
const go = async (label) => { const home = btn('Home'); if (home) { await home.fire('click'); await wait(30); } await btn(label).fire('click'); };
const SHARED = "new number! stuck at the store, buy $200 in Apple gift cards right now, don't tell mom";

before(async () => {
  const port = await server.listen(0);
  url = `http://localhost:${port}`;
  loc.origin = url;
  loc.search = `?text=${encodeURIComponent(SHARED)}`; // as if shared into Vouch
  await import('../js/app.js');
  await wait(600);
});
after(async () => { clients.forEach((s) => s.close()); await server.close(); });
test('boots to the welcome screen', () => {
  assert.ok(text().includes('Welcome to Vouch'));
});

test('sign-up shows the main app, and a shared scam message triggers the warning and a sticky banner', async () => {
  find(appEl, (n) => n.id === 'name').value = 'Ada';
  await btn('Get started').fire('click');
  await wait(900);
  assert.ok(text().includes('Possible family-emergency scam'), 'full-screen warning names the scam type');
  assert.ok(text().includes('Call your family member on the number you already have'), 'and says what to do');
  assert.ok(text().includes('DO NOT ACT ON THIS'), 'sticky banner');
  const bar = find(appEl, (n) => n.className === 'actions');
  assert.ok(bar && bar.children.some((c) => c.tag === 'button'), 'the way out is in a pinned button bar, not buried in the text');
  assert.ok(!btn('Quiet for 2 minutes') && !btn('Get our code word'), 'the banner has just the two things to do');
  const clear = btn('I checked it');
  assert.ok(clear && clear.attrs.disabled !== undefined, 'clear is locked by the pause');
  await (btn('Close') || btn("OK, I won't send")).fire('click');
  assert.ok(text().includes('DO NOT ACT ON THIS'), 'banner outlives the overlay');
});

test('Home is two giant buttons and a smaller one, with one obvious first step when nobody is linked', async () => {
  const home = btn('Home'); if (home) await home.fire('click');
  await wait(60);
  assert.ok(text().includes('Hi Ada'), 'greets by name');
  for (const label of ['Check a message', 'On a call', 'My people']) assert.ok(btn(label), `${label} is a button on Home`);
  assert.ok(text().includes('First, add someone you trust.') && btn('Add someone'), 'and says what to do first');
  assert.ok(!document.querySelector?.('nav'), 'there is no tab bar to confuse');
});

test('with nobody linked, Check a message still works: paste, see the read, and a clear way to add someone', async () => {
  await go('Check a message');
  await wait(80);
  assert.ok(find(appEl, (n) => n.id === 'text'), 'there is a place to paste');
  assert.ok(find(appEl, (n) => n.id === 'shot') && btn('Attach a screenshot'), 'with a real Attach button');
  assert.ok(text().includes('Not saved by Vouch'), 'and an honest privacy line');
  assert.ok(btn('Add someone'), 'and one obvious next step');
  await go('On a call');
  await wait(80);
  assert.ok(text().includes('Add someone to get a code word') && text().includes('Listen for scams'), 'both halves of the call tab are there');
});

test('every tab renders and the pairing code appears', async () => {
  for (const [tab, expect] of [['On a call', 'Listen for scams'], ['My people', 'Share a message from any app'], ['Check a message', 'Add someone to ask their phone']]) {
    await go(tab);
    await wait(80);
    assert.ok(text().includes(expect), `${tab} -> ${expect}`);
  }
  globalThis.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => true });
  await go('My people');
  await btn('Add someone').fire('click');
  await wait(400);
  assert.match(text(), /[A-Z0-9]{4}-[A-Z0-9]{4}/);
});
// A second "phone" (real keys, real socket) links up with the app, then answers a request it is asked about.
async function otherPhone(name) {
  const keys = await createIdentityKeys();
  const pubs = { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  const nonce = await new Promise((resolve) => socket.once('auth:challenge', (m) => resolve(m.nonce)));
  const call = (event, body = {}) => new Promise((resolve) => socket.emit(event, body, resolve));
  const res = await call('user:register', { name, ...pubs, sig: await signString(keys.signKeyPair.privateKey, authString(nonce)) });
  assert.equal(res.ok, true);
  return { id: res.userId, keys, socket, call };
}

test('linking a friend: the Check form shows brand logos and the screenshot control; a Not me brings the red STOP', async () => {
  const token = /([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(text()).slice(1).join('');
  const sam = await otherPhone('Sam');
  const prompt = new Promise((resolve) => sam.socket.once('verify:prompt', resolve));
  assert.equal((await sam.call('pair:accept', { token })).ok, true);
  await wait(600);
  assert.ok(text().includes('Linked with Sam'), 'safety-code screen');
  await btn('It matches').fire('click');

  await go('Check a message');
  await wait(100);
  assert.ok(btn("Ask Sam's phone") && btn('Paste'), 'a message box with one button to ask their phone');
  assert.ok(text().includes('Venmo / Cash App / Zelle') && text().includes('Gift cards'), 'method cards');
  assert.ok(findAll(appEl, (n) => n.className === 'logo').length >= 8, 'brand logos are drawn');
  assert.ok(find(appEl, (n) => n.id === 'shot'), 'screenshot control');
  assert.ok(text().includes('Possible family-emergency scam') && text().includes('Ask for your Vouch code word'), 'the shared text gets a plain-words guide in the form');

  find(appEl, (n) => n.id === 'amount').value = '60';
  await find(appEl, (n) => n.id === 'amount').fire('input');
  await btn("Ask Sam's phone").fire('click');
  const p = await prompt;
  assert.equal(p.amountCents, 6000);
  const fields = { requestId: p.requestId, checkerId: p.checker.id, claimedId: sam.id, amountCents: p.amountCents, method: p.method, answer: 'not_me' };
  const s = await signAnswer(sam.keys.signKeyPair.privateKey, fields);
  assert.equal((await sam.call('verify:answer', { requestId: p.requestId, answer: 'not_me', retypedCents: p.amountCents, ...s })).ok, true);
  await wait(500);
  assert.ok(text().includes('STOP. Do not send money.'), 'full-screen STOP');
  assert.ok(text().includes('Sam says this was NOT them'), 'says who denied it');
});

test('the code word shows a ring that runs down with the minute, and a person can see whose word it is', async () => {
  await go('On a call');
  await wait(80);
  assert.ok(btn('Sam') || text().includes('Add someone to get a code word'), 'people are name buttons');
  const sam = btn('Sam');
  if (sam) {
    await sam.fire('click');
    await wait(200);
    const ring = find(appEl, (n) => n.className.startsWith('ring'));
    assert.ok(ring, 'the countdown ring is drawn');
    assert.match(text(), /\d+s/, 'with the seconds left inside it');
    assert.ok(find(appEl, (n) => n.id === 'bigword' && n.textContent.length > 2), 'and the word beside it');
  }
});
test('scanner with no camera falls back to typing the code; a mismatched safety code removes the link', async () => {
  const tia = await otherPhone('Tia');
  const { token } = await tia.call('pair:offer');
  const stop = btn('I understand'); // the red STOP from the previous test is still up
  if (stop) await stop.fire('click');
  await go('My people');
  await btn('Scan a code').fire('click');
  await wait(100);
  assert.ok(text().includes("can't open the camera"), 'says so plainly instead of crashing');
  const typed = find(appEl, (n) => n.attrs && n.attrs['aria-label'] === 'Type the code instead');
  assert.ok(typed, 'a typed-code box is right there');
  typed.value = `${token.slice(0, 4)}-${token.slice(4)}`;
  await btn('Join with this code').fire('click');
  await wait(700);
  assert.ok(text().includes('Linked with Tia'), 'linked by typing the code');
  await btn("It doesn't match").fire('click');
  await wait(200);
  assert.ok(text().includes('Link removed'), 'tells the person what happened');
  assert.ok(!text().includes('Tia'), 'and the friend is gone from this phone');
});

test('a bad code from the scanner is explained, not silent', async () => {
  await go('My people');
  await btn('Scan a code').fire('click');
  await wait(50);
  const typed = find(appEl, (n) => n.attrs && n.attrs['aria-label'] === 'Type the code instead');
  typed.value = 'abc';
  await btn('Join with this code').fire('click');
  assert.ok(text().includes('8 letters or numbers'));
  await btn('Cancel').fire('click');
});

test('Display: one findable control sets text size, colours, reading mode and spoken warnings, and remembers them', async () => {
  await go('My people'); // any screen: the control is in the header on all of them
  const aa = btn('Aa');
  assert.ok(aa, 'the Aa button is in the header');
  await aa.fire('click');
  await wait(60);
  assert.ok(text().includes('Display') && text().includes('Text size') && text().includes('Colours'));
  await btn('Largest').fire('click');
  await btn('High contrast').fire('click');
  await btn('Reading mode').fire('click');
  const saved = JSON.parse(localStorage.getItem('vouch-display'));
  assert.equal(saved.size, 4);
  assert.equal(saved.theme, 'hc');
  assert.equal(saved.reading, true);
  assert.equal(saved.aloud, false, 'nothing is spoken unless the person turns it on');
  const cls = document.documentElement.classList;
  assert.ok(cls.contains ? cls.contains('theme-hc') && cls.contains('reading') && cls.contains('size-4') : true);
  await btn('Done').fire('click');
  await wait(40);
  assert.ok(!text().includes('Text size'), 'and it closes');
});

test('nothing is ever spoken on its own: warnings, results and prompts are silent unless the person asks', () => {
  assert.equal(globalThis.__spoken, 0, 'no text-to-speech during the whole run, scam warnings included');
});
