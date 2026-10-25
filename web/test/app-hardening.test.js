// The real app against the v2 reference server, aimed at the things that go wrong in real life: a removed person coming back on
// reconnect, two people with one name, one person's "yes" hiding another danger, a question that outlives its clock, and being asked
// by someone this phone never linked with.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createMockServer } from '../dev/mock-server.js';
import { installFakeDom } from '../dev/fakedom.js';
import { authString } from '../js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString, signAnswer } from '../js/lib/crypto.js';

const server = createMockServer();
const clients = [];
let url = '';
const dom = installFakeDom({ makeSocket: () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; } });
const { appEl, loc, wait, text, btn, find } = dom;
const go = async (label) => { const home = btn('Home'); if (home) { await home.fire('click'); await wait(30); } await btn(label).fire('click'); };
const SCAM = "new number! stuck at the store, buy $200 in Apple gift cards right now, don't tell mom";

before(async () => {
  url = `http://localhost:${await server.listen(0)}`;
  loc.origin = url;
  loc.search = `?text=${encodeURIComponent(SCAM)}`; // a scam shared into Vouch: raises the "message" danger
  await import('../js/app.js');
  await wait(600);
});
after(async () => { clients.forEach((s) => s.close()); await server.close(); });

async function otherPhone(name) {
  const keys = await createIdentityKeys();
  const pubs = { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  const nonce = await new Promise((resolve) => socket.once('auth:challenge', (m) => resolve(m.nonce)));
  const call = (event, body = {}) => new Promise((resolve) => socket.emit(event, body, resolve));
  const res = await call('user:register', { name, ...pubs, sig: await signString(keys.signKeyPair.privateKey, authString(nonce)) });
  assert.equal(res.ok, true);
  return { id: res.userId, keys, socket, call, pubs };
}
// Join a phone that is showing a pairing code, by typing the code (the camera-less path).
async function joinByTyping(phone) {
  const { token } = await phone.call('pair:offer');
  await go('My people');
  await btn('Scan a code').fire('click');
  await wait(80);
  const typed = find(appEl, (n) => n.attrs && n.attrs['aria-label'] === 'Type the code instead');
  typed.value = `${token.slice(0, 4)}-${token.slice(4)}`;
  await btn('Join with this code').fire('click');
  await wait(600);
}
const dismissAll = async () => { for (let i = 0; i < 6; i++) { const b = btn('Close') || btn("OK, I won't send") || btn('I understand'); if (!b) break; await b.fire('click'); await wait(20); } };
const reconnect = async () => { const s = clients[0]; s.disconnect(); await wait(80); s.connect(); await wait(700); };

test('sign up; the shared scam raises the "message" danger, and it is saved so a reload cannot hide it', async () => {
  find(appEl, (n) => n.id === 'name').value = 'Ada';
  await btn('Get started').fire('click');
  await wait(900);
  assert.ok(text().includes('DO NOT ACT ON THIS'));
  const saved = JSON.parse(localStorage.getItem('vouch-alerts'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'message');
  assert.ok(!JSON.stringify(saved).includes('Apple') && !JSON.stringify(saved).includes('$200'), 'only the level and fixed wording, never the message');
  await dismissAll();
});

test('a person removed on purpose stays removed after the app reconnects, and pairing again on purpose brings them back', async () => {
  const tia = await otherPhone('Tia');
  await joinByTyping(tia);
  assert.ok(text().includes('Linked with Tia'));
  await btn("It doesn't match").fire('click'); // a tampered link: removed here, but the server still lists it
  await wait(200);
  await reconnect();
  await go('My people');
  assert.ok(!text().includes('Tia'), 'not back after the sync that follows a reconnect');
  // pairing with Tia again, deliberately, is allowed
  tia.socket.close();
  const tia2 = await otherPhone('Tia');
  await joinByTyping(tia2);
  assert.ok(text().includes('Linked with Tia'));
  await btn('It matches').fire('click');
  await wait(100);
  await go('My people');
  assert.ok(text().includes('Tia'));
});

test('two different people called Mom both stay, with stable labels', async () => {
  const a = await otherPhone('Mom'); await joinByTyping(a); await btn('It matches').fire('click'); await wait(100);
  const b = await otherPhone('Mom'); await joinByTyping(b); await btn('It matches').fire('click'); await wait(100);
  await go('On a call');
  await wait(80);
  assert.ok(btn('Mom (1)') && btn('Mom (2)'), 'both are there, told apart');
  await reconnect();
  await go('On a call');
  assert.ok(btn('Mom (1)') && btn('Mom (2)'), 'and still both after a reconnect');
});

test("a friend's yes resolves that request only: the scam warning from earlier is still up", async () => {
  const sam = await otherPhone('Sam');
  await joinByTyping(sam);
  await btn('It matches').fire('click');
  await wait(100);
  // the earlier "message" danger was dismissed from the screen but is still unresolved; raise it again by sharing, then check a small amount with Sam
  const prompt = new Promise((resolve) => sam.socket.once('verify:prompt', resolve));
  await go('Check a message');
  await wait(80);
  const samBtn = btn('Sam');
  assert.ok(samBtn, 'the names of the trusted people are right there to pick');
  await samBtn.fire('click');
  find(appEl, (n) => n.id === 'amount').value = '10';
  await find(appEl, (n) => n.id === 'amount').fire('input');
  await btn("Ask Sam's phone").fire('click');
  const p = await prompt;
  const s = await signAnswer(sam.keys.signKeyPair.privateKey, { requestId: p.requestId, checkerId: p.checker.id, claimedId: sam.id, amountCents: p.amountCents, method: p.method, answer: 'yes' });
  await sam.call('verify:answer', { requestId: p.requestId, answer: 'yes', ...s });
  await wait(600);
  assert.ok(text().includes('DO NOT ACT ON THIS') || JSON.parse(localStorage.getItem('vouch-alerts')).some((a) => a.source === 'message'),
    'the earlier warning about the shared message was not wiped by Sam saying yes');
});

test('a question with a clock goes ahead of a warning, and the screen admits when it has timed out', async () => {
  const sam = await otherPhone('Sam2');
  await joinByTyping(sam);
  await btn('It matches').fire('click');
  await wait(100);
  await dismissAll();
  const ada = (await sam.call('circle:list')).friends.find((f) => f.name === 'Ada');
  assert.ok(ada, 'Sam2 is linked with Ada on the server');
  const asked = sam.call('verify:request', { claimedId: ada.id, amountCents: 3000, method: 'venmo_cashapp_zelle', channel: 'text' });
  await wait(500);
  assert.ok(text().includes('Did you just ask Sam2 for $30.00'), 'the question is what Ada sees');
  assert.ok(text().includes('left to answer'), 'with the time she has');
  // two minutes pass
  const real = Date.now; Date.now = () => real() + 130000;
  try { await wait(1300); } finally { Date.now = real; }
  assert.ok(text().includes('This request timed out. Nothing was sent.'), 'the screen no longer pretends it can be answered');
  assert.ok(!btn('Yes, that was me'), 'and the Yes button is gone');
  await btn('Close').fire('click');
  void asked;
});

test('someone this phone never linked with is named as a stranger when they ask', async () => {
  const eve = await otherPhone('Eve');
  await joinByTyping(eve);
  await btn("It doesn't match").fire('click'); // removed locally, still linked on the server
  await wait(200);
  const ada = (await eve.call('circle:list')).friends.find((f) => f.name === 'Ada');
  assert.ok(ada);
  await eve.call('verify:request', { claimedId: ada.id, amountCents: 2000, method: 'venmo_cashapp_zelle', channel: 'text' });
  await wait(500);
  assert.ok(text().includes("You haven't linked with this person on this phone"), 'a clear warning, not a quiet yes/no');
});
