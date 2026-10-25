// Boots the real web/js/app.js under a minimal fake DOM, connected to the v2 reference server over a real socket,
// and drives the UI: sign-up, every tab, the pairing code, and the warning a shared scam message triggers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createMockServer } from '../dev/mock-server.js';
import { authString } from '../js/lib/canonical.js';
import { createIdentityKeys, exportPub, signString, signAnswer } from '../js/lib/crypto.js';

const server = createMockServer();
const clients = [];
let url = '';
// Keep the app's timers from holding the test process open.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };
// ---- minimal DOM ----
class ClassList { constructor(el) { this.el = el; } add(...c) { const s = new Set(this.el.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); this.el.className = [...s].join(' '); } remove(...c) { const s = new Set(this.el.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.delete(x)); this.el.className = [...s].join(' '); } toggle(c, on) { on ? this.add(c) : this.remove(c); } contains(c) { return this.el.className.split(/\s+/).includes(c); } }
class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; this.listeners = {}; this.dataset = {}; this.style = {}; this.parent = null; this._text = ''; this.hidden = false; this.disabled = false; this.value = ''; this.classList = new ClassList(this); }
  get nodeType() { return 1; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === document.body || n === document.documentElement; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  append(...kids) { for (const k of kids) { if (typeof k === 'string') { const t = new Node_('#text'); t._text = k; t.parent = this; this.children.push(t); } else { if (k.parent) k.parent.children = k.parent.children.filter((c) => c !== k); k.parent = this; this.children.push(k); } } }
  replaceChildren(...kids) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  fire(t, ev = {}) { return Promise.all((this.listeners[t] || []).map((fn) => fn({ target: this, ...ev }))); }
  get textContent() { return this.tag === '#text' ? this._text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; if (v !== '') this.append(String(v)); }
  focus() {} scrollIntoView() {} play() { return Promise.resolve(); } getContext() { return { fillRect() {}, drawImage() {}, getImageData() { return { data: [] }; } }; }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk && c.walk(fn)); }
  querySelectorAll(sel) { const out = []; this.walk((n) => { if (n !== this && match(n, sel)) out.push(n); }); return out; }
  querySelector(sel) { if (sel === '.inner > *') { let r = null; this.walk((n) => { if (!r && n.parent && n.parent.className.split(/\s+/).includes('inner')) r = n; }); return r; } return this.querySelectorAll(sel)[0] || null; }
}
function match(n, sel) { if (sel.startsWith('.')) return n.className.split(/\s+/).includes(sel.slice(1)); if (sel.startsWith('#')) return n.id === sel.slice(1); return n.tag === sel; }
const find = (root, pred) => { let r = null; root.walk((n) => { if (!r && pred(n)) r = n; }); return r; };
const findAll = (root, pred) => { const r = []; root.walk((n) => { if (pred(n)) r.push(n); }); return r; };

const body = new Node_('body'); const htmlEl = new Node_('html'); htmlEl.append(body);
const appEl = new Node_('div'); appEl.setAttribute('id', 'app'); body.append(appEl);
globalThis.document = { body, documentElement: htmlEl, createElement: (t) => new Node_(t), getElementById: (id) => find(htmlEl, (n) => n.id === id), hidden: false };
globalThis.location = { origin: `${url}`, hash: '', search: '', pathname: '/' };
globalThis.history = { replaceState() {} };
const store = new Map();
Object.defineProperty(globalThis, 'navigator', { value: { vibrate() {}, clipboard: { readText: async () => '' }, serviceWorker: undefined, mediaDevices: undefined }, configurable: true });
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
globalThis.requestAnimationFrame = () => {};
globalThis.speechSynthesis = { cancel() {}, speak() {} }; globalThis.SpeechSynthesisUtterance = class {};
globalThis.io = () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => appEl.textContent;
const btn = (label) => find(appEl, (n) => n.tag === 'button' && n.textContent.trim().startsWith(label));
const SHARED = "new number! stuck at the store, buy $200 in Apple gift cards right now, don't tell mom";

before(async () => {
  const port = await server.listen(0);
  url = `http://localhost:${port}`;
  globalThis.location.origin = url;
  globalThis.location.search = `?text=${encodeURIComponent(SHARED)}`; // as if shared into Vouch
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
  assert.ok(text().includes('This looks like a scam'), 'full-screen warning');
  assert.ok(text().includes('DO NOT SEND ANYTHING'), 'sticky banner');
  const clear = btn('I checked it');
  assert.ok(clear && clear.attrs.disabled !== undefined, 'clear is locked by the pause');
  await btn('Not now').fire('click');
  assert.ok(text().includes('DO NOT SEND ANYTHING'), 'banner outlives the overlay');
});

test('every tab renders and the pairing code appears', async () => {
  for (const [tab, expect] of [['On a call', 'Link up with someone first'], ['My people', 'Send messages to Vouch'], ['Check a message', 'First, link up']]) {
    await btn(tab).fire('click');
    await wait(80);
    assert.ok(text().includes(expect), `${tab} -> ${expect}`);
  }
  globalThis.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => true });
  await btn('My people').fire('click');
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

  await btn('Check a message').fire('click');
  await wait(100);
  assert.ok(text().includes('Is this request real?'));
  assert.ok(text().includes('Venmo / Cash App / Zelle') && text().includes('Gift cards'), 'method cards');
  assert.ok(findAll(appEl, (n) => n.className === 'logo').length >= 8, 'brand logos are drawn');
  assert.ok(find(appEl, (n) => n.id === 'shot'), 'screenshot control');
  assert.ok(text().includes('Looks risky'), 'the shared scam text is flagged in the form');

  find(appEl, (n) => n.id === 'amount').value = '60';
  await find(appEl, (n) => n.id === 'amount').fire('input');
  await btn('Check now').fire('click');
  const p = await prompt;
  assert.equal(p.amountCents, 6000);
  const fields = { requestId: p.requestId, checkerId: p.checker.id, claimedId: sam.id, amountCents: p.amountCents, method: p.method, answer: 'not_me' };
  const s = await signAnswer(sam.keys.signKeyPair.privateKey, fields);
  assert.equal((await sam.call('verify:answer', { requestId: p.requestId, answer: 'not_me', retypedCents: p.amountCents, ...s })).ok, true);
  await wait(500);
  assert.ok(text().includes('STOP. Do not send money.'), 'full-screen STOP');
  assert.ok(text().includes('Sam says this was NOT them'), 'says who denied it');
});
