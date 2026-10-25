// A minimal fake browser page, just enough to run the real web/js/app.js in Node for tests and to drive its UI.
// Dev/test only: it is never served to users. Usage: const dom = installFakeDom({ makeSocket }); await import('../js/app.js').
// Note it keeps the app's timers from holding the test process open.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };
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

/** Installs the fake page on globalThis. makeSocket() returns the socket the app's `io()` should use. */
export function installFakeDom({ makeSocket }) {
  const body = new Node_('body'); const htmlEl = new Node_('html'); htmlEl.append(body);
  const appEl = new Node_('div'); appEl.setAttribute('id', 'app'); body.append(appEl);
  globalThis.document = { body, documentElement: htmlEl, createElement: (t) => new Node_(t), getElementById: (id) => find(htmlEl, (n) => n.id === id), querySelectorAll: (sel) => htmlEl.querySelectorAll(sel), querySelector: (sel) => htmlEl.querySelector(sel), hidden: false };
  const loc = { origin: '', hash: '', search: '', pathname: '/' };
  globalThis.location = loc;
  globalThis.history = { replaceState() {} };
  const store = new Map();
  const nav = { vibrate() {}, clipboard: { readText: async () => '' }, serviceWorker: undefined, mediaDevices: undefined, userAgent: 'test' };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.requestAnimationFrame = () => {};
  globalThis.speechSynthesis = { cancel() {}, speak() {} };
  globalThis.SpeechSynthesisUtterance = class {};
  globalThis.io = () => makeSocket();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => appEl.textContent;
  const btn = (label) => find(appEl, (n) => n.tag === 'button' && n.textContent.trim().startsWith(label));
  return { appEl, loc, nav, wait, text, btn, find, findAll };
}