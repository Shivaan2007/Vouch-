// Vouch phone app (PROTOCOL v2). Plain ES modules, no build step.
// Every dynamic string goes through textContent (h() below), never innerHTML.

import {
  createIdentityKeys, exportPub, signString, deriveWordKey, currentWord, checkWord,
  safetyCode, verifyAnswer, signAnswer, signConfirm,
} from './lib/crypto.js';
import { authString } from './lib/canonical.js';
import * as store from './lib/store.js';
import { connect, call, on } from './lib/api.js';
import { TAG_LABELS as TAGS, suggest, riskyEnough, callRisk, classify, highlight } from './lib/scan.js';
import { chunkToWav } from './lib/audio.js';

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

// The browser's own replaceChildren writes the word "null" onto the screen if it is handed a null; never let that happen.
if (globalThis.Element && Element.prototype.replaceChildren) {
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function replaceChildren(...kids) { return nativeReplace.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
}

const fmt = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function parseCents(text) {
  const m = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text).replace(/,/g, '').trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
}

const METHODS = [
  ['venmo_cashapp_zelle', 'Venmo / Cash App / Zelle'], ['gift_card', 'Gift cards'], ['wire', 'Wire transfer'],
  ['crypto', 'Crypto'], ['cash_in_person', 'Cash in person'], ['other', 'Other'], ['unknown', "I don't know"],
];
const CHANNELS = [['text', 'Text'], ['call', 'Call'], ['dm', 'App / DM'], ['email', 'Email']];
const label = (list, key) => (list.find(([k]) => k === key) || [key, key])[1];
const ERRORS = {
  OFFLINE: "You're offline. Reconnecting…", TIMEOUT: 'The server took too long. Try again.',
  TOKEN_INVALID: 'That code is invalid or expired.', ALREADY_PAIRED: "You're already linked.",
  SELF_PAIR: "That's your own code.", NOT_PAIRED: 'Not connected to them right now. Link up again in My people. Your code word still works.',
  AMOUNT_MISMATCH: "The amount you typed doesn't match.", BAD_SIGNATURE: "Your signature wasn't accepted.",
  ALREADY_ANSWERED: 'This was already answered.', NOT_FOUND: 'This request is gone.',
  RATE_LIMITED: 'Slow down a little.', BAD_INPUT: 'Check what you entered.',
  BAD_IMAGE: "Couldn't read that picture. Try a screenshot.", IMAGE_TOO_BIG: 'That picture is too large. Try a smaller screenshot.',
  NEED_AMOUNT: 'Please type how much they asked for, like 60 or 60.50.', NEED_FRIEND: 'Link up with someone you trust first.',
};
ERRORS.NEED_FRIEND = 'Pick who it says it is.';
Object.assign(ERRORS, {
  UNKNOWN_USER: 'Vouch lost your account on the server. Reload the page.', UNAUTHENTICATED: 'Signing in again… try in a moment.',
  NO_STT: "The Vouch server can't listen right now. Type what you hear instead.", STT_FAILED: "Couldn't turn that into words. Still listening.",
  SERVER_ERROR: 'The server had a problem. Try again in a moment.',
});
// Never show a code to a person; the code goes to the console for whoever is debugging.
const friendly = (e) => {
  const code = e && e.message;
  if (!ERRORS[code]) console.warn('Vouch error:', code);
  return ERRORS[code] || 'Something went wrong. Try again.';
};

// A row of big name buttons, one per trusted person: tap a name to pick them. Two people with the same name get a number.
function people(legend, selected, onpick, { other = false } = {}) {
  const seen = {};
  const dup = S.friends.reduce((m, f) => { m[f.name] = (m[f.name] || 0) + 1; return m; }, {});
  const items = S.friends.map((f) => { seen[f.name] = (seen[f.name] || 0) + 1; return [f.id, dup[f.name] > 1 ? `${f.name} (${seen[f.name]})` : f.name]; });
  if (other) items.push(['other', 'Someone else']);
  return h('div', { class: 'people', role: 'group', 'aria-label': legend },
    h('p', { class: 'peoplelabel' }, legend),
    h('div', { class: 'chips' }, items.map(([id, name]) =>
      h('button', { class: 'chipbtn', 'aria-pressed': String(id === selected), onclick: () => onpick(id) }, name))));
}

// Big radio cards (native inputs, so screen readers and keyboards work).
// Brand marks (web/img/brands, CC0 Simple Icons; see NOTICE.md) shown next to the payment method or app they stand for.
// They are drawn with the text colour, so they follow light and dark mode. Decorative: the words carry the meaning.
const METHOD_LOGOS = {
  venmo_cashapp_zelle: ['venmo', 'cashapp', 'zelle'], gift_card: ['apple', 'googleplay', 'steam', 'target'],
  wire: ['westernunion'], crypto: ['bitcoin', 'ethereum'],
};
const CHANNEL_LOGOS = {
  text: ['imessage', 'googlemessages'], call: ['phone'], dm: ['whatsapp', 'messenger', 'telegram', 'instagram'], email: ['gmail'],
};
function logos(names, size) {
  if (!names || !names.length) return null;
  return h('span', { class: `logos${size ? ` ${size}` : ''}`, 'aria-hidden': 'true' },
    names.map((n) => h('span', { class: 'logo', style: `--src:url(/img/brands/${n}.svg)`})));
}

let choiceSeq = 0;
// options: [value, text, optionalLogoNames]. The returned fieldset has setValue(v) to change the selection from code.
function choice(legend, options, selected, onchange, cls) {
  const name = `c${++choiceSeq}`;
  const fs = h('fieldset', null, h('legend', null, legend),
    h('div', { class: `choices ${cls || ''}` }, options.map(([value, text, brands]) =>
      h('label', { class: 'choice' },
        h('input', { type: 'radio', name, value, checked: value === selected, onchange: () => onchange(value) }),
        h('span', { class: 'face' }, logos(brands), h('span', null, text))))));
  fs.setValue = (v) => fs.querySelectorAll('input').forEach((i) => { i.checked = i.value === v; });
  return fs;
}

const MAX_IMAGE_CHARS = 3_900_000; // the server accepts up to 4 MB as a data URL
// Shrink a picked screenshot to a JPEG the server accepts. Nothing leaves the phone until "Check now".
async function readScreenshot(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('BAD_IMAGE'));
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.8, 0.6, 0.4]) {
      const d = c.toDataURL('image/jpeg', q);
      if (d.startsWith('data:image/jpeg') && d.length <= MAX_IMAGE_CHARS) return d;
    }
    throw new Error('IMAGE_TOO_BIG');
  } finally { URL.revokeObjectURL(url); }
}

// ElevenLabs voice for the four FIXED alerts (stop, wait, ok, call). The server serves the audio from /tts/<phrase>; no text of ours is
// sent anywhere. The clips are fetched once after sign-in, so the first alert is instant. If a clip is not ready or anything fails,
// the built-in voice speaks the usual line at once, exactly as before. Alerts with a name or an amount always use the built-in voice.
const VOICE_PHRASES = ['stop', 'wait', 'ok', 'call'];
const voice = { clips: new Map(), warmed: false, el: null };
// iPhones only let a page play sound that a tap started. Alerts arrive over the network with no tap, so on the person's first tap we
// start one silent sound on a single audio element and reuse that element for every later alert (its source is swapped, not recreated).
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';
function unlockVoice() {
  if (voice.el) return;
  try {
    const el = new Audio(SILENT);
    voice.el = el;
    Promise.resolve(el.play()).catch(() => { voice.el = null; }); // blocked: try again on the next tap
  } catch { voice.el = null; }
}
// Only where there is a real window (the team's Node smoke tests load this file without one).
if (typeof addEventListener === 'function') for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, unlockVoice, { capture: true, passive: true });

async function warmVoice() {
  if (voice.warmed) return;
  voice.warmed = true;
  try {
    for (const id of VOICE_PHRASES) {
      const r = await fetch(`/tts/${id}`);
      if (!r.ok) return; // no key (503), cooling down, or an error: stay on the built-in voice this session
      voice.clips.set(id, URL.createObjectURL(await r.blob()));
    }
  } catch { /* offline: the built-in voice still works */ }
}

function speakBuiltIn(text) {
  try {
    if ('speechSynthesis' in globalThis) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      speechSynthesis.speak(u);
    }
  } catch { /* not supported */ }
}

// Get a person's attention without relying on sight alone: vibrate (Android) and speak aloud.
// `phrase` (optional) names one of the fixed ElevenLabs clips; `text` is always the built-in fallback.
function attention(text, pattern, phrase) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ }
  const clip = phrase && voice.clips.get(phrase);
  if (!clip) { speakBuiltIn(text); return; }
  try {
    if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
    const a = voice.el || new Audio(); // the unlocked element if there is one; a fresh one still works on most desktops and Androids
    a.pause();
    a.src = clip;
    Promise.resolve(a.play()).catch(() => speakBuiltIn(text)); // blocked or a bad clip: fall back to the built-in voice
  } catch { speakBuiltIn(text); }
}

// System notification when Vouch is in the background (needs permission; see "Alerts" under My people).
function notify(title, body, tag) {
  try {
    if (!('Notification' in globalThis) || Notification.permission !== 'granted' || !document.hidden) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) reg.showNotification(title, { body, tag, renotify: true, requireInteraction: true, icon: './icon.svg' });
      else new Notification(title, { body, tag });
    }).catch(() => {});
  } catch { /* not supported */ }
}

// Text size: three steps, remembered on this phone only.
function applySize(n) {
  document.documentElement.classList.remove('size-2', 'size-3');
  if (n > 1) document.documentElement.classList.add(`size-${n}`);
}
function loadSize() { try { return Number(localStorage.getItem('vouch-size')) || 1; } catch { return 1; } }
function saveSize(n) { try { localStorage.setItem('vouch-size', String(n)); } catch { /* ignore */ } }

// ---------- state ----------

const S = {
  me: null, keys: null, pubs: null, nonce: null, authed: false, online: false,
  friends: [], tab: 'home', pendingPair: null, current: null, results: new Map(), texts: new Map(),
  drafts: {}, queue: [], codeView: null, scanning: false, stream: null, wordFriendId: null,
  announced: new Map(), size: 1, forgetAsk: false, bootError: '',
  form: { friendId: '', method: 'venmo_cashapp_zelle', channel: 'text', amount: '', text: '', image: '', amountTouched: false, methodTouched: false },
};
const $app = document.getElementById('app');
let $content, $status, $banners, $overlay, $toast, $conn, $callbar;
let toastTimer = null;
const SOURCE_NAMES = { telegram: 'Telegram', sms: 'a text message', whatsapp: 'WhatsApp' };
const SOURCE_APP = { telegram: 'Telegram', sms: 'Text messages', whatsapp: 'WhatsApp' };
const friendById = (id) => S.friends.find((f) => f.id === id);
// Is this person known to the server right now? Unknown until the first sync, so assume yes.
const isLinked = (f) => !S.linked || S.linked.has(f.id);

function toast(msg, kind) {
  if (!$toast) return;
  $toast.replaceChildren(h('p', { class: kind === 'ok' ? 'ok' : 'err' }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.replaceChildren(), 5000);
}

// ---------- danger state: stays in your face until it is resolved ----------
// Scams work by rushing people. While something risky is unresolved Vouch keeps a red banner on screen and makes you wait
// before you can wave it away. It speaks the warning once; it does not keep repeating it aloud (that was only annoying).

const PAUSE_SECONDS = 10; // the same cooling-off pause the server config documents
const A = { active: false, level: 0, reason: '', source: '', repeats: 0, mutedUntil: 0 };
let $sticky;

// A button that stays disabled for a few seconds, so a warning can't be dismissed on reflex.
function pauseButton(text, seconds, onclick, cls) {
  const b = h('button', { class: cls || '', disabled: true }, `${text} (${seconds})`);
  let n = seconds;
  const t = setInterval(() => {
    n -= 1;
    if (!b.isConnected && n < seconds - 1) { clearInterval(t); return; }
    if (n <= 0) { clearInterval(t); b.disabled = false; b.textContent = text; } else b.textContent = `${text} (${n})`;
  }, 1000);
  b.addEventListener('click', onclick);
  return b;
}

// Who a warning can name without guessing: the person picked on the call tab, or the only person there is. With several
// trusted people and none picked, nobody, so the buttons say "a trusted person" instead of naming the wrong one.
function likelyFriend() {
  const picked = S.callWith && S.callWith !== 'other' ? friendById(S.callWith) : null;
  return picked || (S.friends.length === 1 ? S.friends[0] : null);
}

function raiseAlert(level, reason, source) {
  const was = A.active;
  const prev = was ? A.level : 0;
  if (was && level < prev) return; // never downgrade an active danger
  const changed = !was || level > prev || source !== A.source;
  A.active = true; A.level = Math.max(level, prev); A.reason = reason; A.source = source;
  if (changed) { A.repeats = 0; paintSticky(); }
}

function clearAlert() {
  A.active = false; A.level = 0; A.reason = ''; A.source = ''; A.repeats = 0;
  paintSticky();
}

function paintSticky() {
  if (!$sticky) return;
  if (!A.active) { $sticky.replaceChildren(); return; }
  const f = likelyFriend();
  $sticky.replaceChildren(h('div', { class: `banner${A.level === 2 ? '' : ' soft'}`, role: 'alert' },
    h('div', { class: 'bannerhead' }, A.level === 2 ? 'DO NOT SEND ANYTHING' : 'WAIT. CHECK FIRST.'),
    h('p', null, A.reason),
    S.friends.length ? h('button', { onclick: () => { if (A.source === 'call') askAboutCall(); else setTab('check'); } }, f ? `Check with ${f.name}'s phone` : "Check with a trusted person's phone") : null,
    pauseButton('I checked it. Clear this', PAUSE_SECONDS, clearAlert, 'ghost')));
}

// ---------- boot + auth ----------

async function boot() {
  try {
    S.me = await store.getIdentity();
    S.keys = await store.getKeys();
    if (!S.me || !S.keys) { S.me = null; S.keys = null; }
    if (S.keys) S.pubs = await pubsOf(S.keys);
    S.friends = await store.listFriends();
  } catch (e) {
    // Don't dead-end: start fresh and show what actually went wrong.
    console.warn('Vouch boot:', e && (e.name + ': ' + e.message));
    S.me = null; S.keys = null; S.pubs = null; S.friends = [];
    S.bootError = (e && (e.name + ': ' + e.message)) || String(e);
  }
  const m = /pair=([A-Za-z0-9]+)/.exec(location.hash);
  if (m) S.pendingPair = m[1].toUpperCase();
  // Android "Share to Vouch": the shared message arrives as ?text=...
  const q = new URLSearchParams(location.search);
  const shared = q.get('text') || q.get('title') || q.get('url');
  if (shared) {
    S.form.text = shared.slice(0, 2000);
    S.tab = 'check';
    history.replaceState(null, '', location.pathname + location.hash);
  }
  S.size = loadSize();
  applySize(S.size);
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch { /* optional */ }
  buildShell();
  // Last line of defence: an error nobody expected is told in plain words, once in a while, and never breaks the page.
  let lastOops = 0;
  const oops = (why) => { console.warn('Vouch:', why); if (S.me && Date.now() - lastOops > 8000) { lastOops = Date.now(); toast('Something went wrong. Try again.'); } };
  globalThis.addEventListener?.('unhandledrejection', (ev) => { oops(ev && ev.reason && ev.reason.message); try { ev.preventDefault?.(); } catch { /* fine */ } });
  globalThis.addEventListener?.('error', (ev) => { if (ev && ev.message && !/ResizeObserver/.test(ev.message)) oops(ev.message); });
  // Coming back to Vouch mid-call: take the screen lock again, and refresh the clock-driven parts at once.
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') { if (S.listening) holdScreen(); tickWord(); tickWait(); } });
  if (!store.isPersistent() || S.bootError) {
    const why = S.bootError || store.storageProblem();
    $banners.append(h('div', { class: 'card' },
      h('p', null, "This browser won't let Vouch save your key, so it can only remember you while this tab stays open. Don't reload or close it during the demo."),
      h('p', { class: 'muted' }, `Details: ${why}`)));
  }
  renderMain();
  wireEvents();
  connect({ onChallenge, onStatus });
  setInterval(() => { tickWord(); tickCode(); tickCall(); tickWait(); }, 1000);
  // A link opened while Vouch is already running (for example a scanned QR in the same tab).
  globalThis.addEventListener?.('hashchange', () => {
    const m = /pair=([A-Za-z0-9]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    const token = m[1].toUpperCase();
    if (S.authed) acceptToken(token); else S.pendingPair = token;
  });
  // Ask the browser to keep this site's saved keys and links (Safari can erase them from sites it thinks are unused).
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* optional */ }
  flashIfRisky(); // a message shared into Vouch is warned about straight away
}

async function pubsOf(keys) {
  return { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
}

function onStatus(online) {
  S.online = online;
  if (online) S.everConnected = true;
  if (!online) S.authed = false;
  paintStatus();
}

async function onChallenge(nonce) {
  S.nonce = nonce;
  S.authed = false;
  paintStatus();
  if (S.me && S.keys) {
    try { await login(); } catch (e) { toast(friendly(e)); }
  } else {
    renderMain(); // shows the setup form
  }
}

async function login() {
  const sig = await signString(S.keys.signKeyPair.privateKey, authString(S.nonce));
  try {
    await call('auth:login', { userId: S.me.id, sig });
  } catch (e) {
    if (e.message !== 'UNKNOWN_USER') throw e;
    // The server forgot us (database wiped). Re-register with the same keys; old pairings are gone.
    await register(S.me.name);
    return;
  }
  await afterAuth();
}

async function register(name) {
  if (!S.nonce) throw new Error('OFFLINE');
  const keys = S.keys || await createIdentityKeys();
  const pubs = S.pubs || await pubsOf(keys);
  const sig = await signString(keys.signKeyPair.privateKey, authString(S.nonce));
  const { userId } = await call('user:register', { name, signPub: pubs.signPub, exchPub: pubs.exchPub, sig });
  S.keys = keys; S.pubs = pubs; S.me = { id: userId, name };
  await store.saveKeys(keys);
  await store.saveIdentity(S.me);
  await afterAuth();
}

async function afterAuth() {
  S.authed = true;
  paintStatus();
  warmVoice(); // not awaited
  await syncFriends();
  loadWatch().then(async () => { // not awaited: a server without Watch just says nothing
    if (S.watch) await loadSenders();
    if (S.tab === 'friends' || S.tab === 'word') renderMain();
  });
  if (S.pendingPair) {
    const token = S.pendingPair;
    S.pendingPair = null;
    history.replaceState(null, '', location.pathname);
    await acceptToken(token);
  }
  renderMain();
  flashIfRisky();
}

async function syncFriends() {
  try {
    const { friends } = await call('circle:list');
    const local = await store.listFriends();
    S.linked = new Set(friends.map((f) => f.id));
    // Links live on this phone until the person removes them: never delete one just because the server forgot it.
    for (const f of friends) {
      // The same person can come back under a new id (the server was wiped). Match by key and update, never duplicate.
      const same = local.filter((l) => l.id === f.id || l.signPub === f.signPub);
      const keep = same.find((l) => l.wordKey && l.exchPub === f.exchPub);
      for (const l of same) if (l.id !== f.id) await store.deleteFriend(l.id);
      const wordKey = keep ? keep.wordKey : await deriveWordKey(S.keys.exchKeyPair.privateKey, f.exchPub);
      await store.saveFriend({ ...f, wordKey, pairedAt: (same[0] && same[0].pairedAt) || f.pairedAt || Date.now() });
    }
    S.friends = await store.listFriends();
  } catch (e) { toast(friendly(e)); }
}

// ---------- shell ----------

function buildShell() {
  $status = h('span', { class: 'pill off', role: 'status' }, 'Offline');
  $conn = h('div', { role: 'status', 'aria-live': 'polite' });
  $sticky = h('div');
  $callbar = h('div', { id: 'callbar' });
  $banners = h('div', { role: 'alert' });
  $toast = h('div', { role: 'status', 'aria-live': 'polite' });
  $content = h('main');
  $overlay = h('div');
  const size = h('button', { class: 'ghost size', 'aria-label': 'Change text size', onclick: () => {
    S.size = (S.size % 3) + 1;
    applySize(S.size);
    saveSize(S.size);
  } }, 'A+');
  $app.replaceChildren(h('header', null, h('h1', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '', width: '28', height: '28' }), 'Vouch'), h('div', { class: 'hgroup' }, $status, size)), $conn, $callbar, $sticky, $banners, $toast, $content, $overlay);
  paintStatus();
}

function paintStatus() {
  if (!$status) return;
  $status.textContent = (S.listening ? 'Watching call · ' : '') + (S.online ? (S.authed ? 'Online' : 'Signing in…') : 'Offline');
  $status.className = 'pill' + (S.online && S.authed ? '' : ' off');
  // Only warn once we've been connected before, so the first second of loading isn't an error.
  if (!S.online && S.everConnected) {
    $conn.replaceChildren(h('div', { class: 'card' },
      h('p', { class: 'err' }, 'No connection.'),
      h('p', null, "Vouch is trying to reconnect. Checks and prompts need a connection. Warnings about messages still work on this phone.")));
  } else $conn.replaceChildren();
}

function setTab(tab) {
  S.tab = tab;
  renderMain();
  try { globalThis.scrollTo?.(0, 0); } catch { /* fine */ }
}

// Every task screen starts the same way: one big way back to Home, and the name of what you are doing.
const topbar = (title) => h('div', { class: 'topbar' }, h('button', { class: 'ghost back', onclick: () => setTab('home') }, 'Home'), h('h2', null, title));

// Home: two giant buttons for the two things people actually need, and a smaller one for the people they trust.
function homeView() {
  const n = S.friends.length;
  const card = (tab, icon, title, sub, cls = '') => h('button', { class: `homecard ${cls}`, onclick: () => setTab(tab) },
    h('span', { class: 'ico', 'aria-hidden': 'true', style: `--src:url(/img/ui/${icon}.svg)`}),
    h('span', { class: 'hc-text' }, h('span', { class: 'hc-title' }, title), h('span', { class: 'hc-sub' }, sub)));
  const linked = (S.watch && S.watch.linked) || [];
  return h('section', null, h('h2', { class: 'hello' }, `Hi ${S.me.name}`),
    n ? null : h('div', { class: 'card' }, h('p', { class: 'big' }, 'First, add someone you trust.'),
      h('p', null, 'A parent, a child, a close friend. Vouch asks their phone to confirm it is really them.'),
      h('button', { onclick: showMyCode }, 'Add someone')),
    card('check', 'message', 'Check a message', 'A text, email or chat asking for money?'),
    card('word', 'call', 'On a call', 'Is the caller really who they say?'),
    card('friends', 'people', 'My people', n ? `Your ${n} trusted ${n === 1 ? 'person' : 'people'} and connected apps` : 'Add family and friends', 'small'),
    linked.length ? h('p', { class: 'muted', style: 'text-align:center' }, 'Messages you forward from a connected app are checked too.') : null);
}

// A screen that fails to draw must never leave a blank page. The keys and people are untouched; reloading brings it back.
function renderMain() {
  try { drawMain(); } catch (e) {
    console.warn('Vouch draw failed:', e && e.message);
    try {
      $content.replaceChildren(h('section', null, h('h2', null, 'Something went wrong'), h('p', null, 'Your keys and the people you linked are safe on this phone.'), h('button', { onclick: () => location.reload() }, 'Reload Vouch')));
      $overlay.replaceChildren(); $overlay.dataset.key = '';
      for (const el of [$conn, $sticky, $banners, $toast, $content, document.getElementById('nav')]) if (el) el.inert = false;
    } catch { /* nothing more can be done */ }
  }
}

function drawMain() {
  if (!S.me) return $content.replaceChildren(setupView());
  if (S.tab === 'home') $content.replaceChildren(homeView());
  else if (S.tab === 'check') { $content.replaceChildren(checkView()); renderResult(); }
  else if (S.tab === 'word') $content.replaceChildren(wordView());
  else $content.replaceChildren(friendsView());
  renderOverlay();
}

// ---------- setup ----------

function setupView() {
  const name = h('input', { id: 'name', maxlength: '20', placeholder: 'Your first name', autocomplete: 'given-name' });
  const msg = h('div', { role: 'alert' });
  const btn = h('button', { onclick: async () => {
    const v = name.value.trim();
    if (!v) { msg.replaceChildren(h('p', { class: 'err' }, 'Please type your name.')); return; }
    btn.disabled = true;
    try { await register(v); } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); btn.disabled = false; }
  } }, 'Get started');
  return h('section', null,
    h('h2', null, 'Welcome to Vouch'),
    h('p', null, 'Vouch checks that a message or call asking for money is really from someone you trust.'),
    h('p', { class: 'muted' }, 'Your phone makes a private key. It never leaves this phone.'),
    installCard(),
    S.pendingPair ? h('p', { class: 'ok' }, "You'll be linked to your friend right after this.") : null,
    h('label', { for: 'name' }, 'Your name'), name, btn, msg);
}

// ---------- check a message ----------

// A plain-words read of what kind of scam this looks like and what to do, from the language of the message or call.
// What the AI found in links and pictures. It never opens a link; it judges the address itself. For pictures it gives a hint,
// not proof: AI is not reliable at telling real photos from generated ones.
function evidenceNodes(g) {
  const out = [];
  if (g && g.links && g.links.length) {
    out.push(h('div', { class: 'evidence' }, h('b', null, 'Links'),
      ...g.links.map((l) => h('div', { class: `linkrow r-${l.risk}` },
        h('span', { class: 'riskpill' }, l.risk.toUpperCase()), h('span', { class: 'linkurl' }, l.url),
        h('span', { class: 'muted' }, `${l.lookalikeOf && l.risk !== 'low' ? `Imitates ${l.lookalikeOf}. ` : ''}${l.why}`))),
      h('p', { class: 'muted' }, 'Vouch did not open these links.')));
  }
  if (g && g.image) {
    const im = g.image;
    out.push(h('div', { class: 'evidence' }, h('b', null, 'Picture'),
      h('p', null, `${im.kind || 'A picture'}.${im.aiGenerated === 'likely' ? ' It looks AI-generated.' : (im.aiGenerated === 'possible' ? ' It might be AI-generated.' : '')}`),
      ...(im.concerns || []).map((c) => h('p', { class: 'muted' }, c)),
      h('p', { class: 'muted' }, 'AI can be wrong about pictures, so treat this as a hint.')));
  }
  return out;
}

function guideCard(g, ai = false) {
  return h('div', { class: 'guide' },
    ai ? h('div', { class: 'aitag' }, 'AI read') : null,
    h('b', null, g.title),
    h('p', null, g.why),
    g.impersonating ? h('p', { class: 'claims' }, `It claims to be: ${g.impersonating}`) : null,
    g.signals && g.signals.length ? h('div', { class: 'flagbar' }, ...g.signals.map((s) => h('span', { class: 'chip' }, s))) : null,
    ...evidenceNodes(g),
    h('ol', { class: 'steps' }, g.steps.map((s) => h('li', null, s))));
}

// The moment a risky message lands (pasted or shared), warn right away, aloud, before anyone has to ask.
// This is an on-phone warning only; it never clears anything.
function flashIfRisky() {
  if (!S.me) return;
  const text = S.form.text;
  const { tags, institution, ask } = suggest(text);
  // A "bank" or "tax office" asking for money is a scam on its own, even with no payment keyword.
  if (!text || !(riskyEnough(tags) || (institution && ask)) || S.flashedFor === text) return;
  S.flashedFor = text;
  S.queue.push({ kind: 'scam', data: { requestId: `local-${Date.now()}`, tags, institution } });
  raiseAlert(2, institution ? 'Banks and government agencies never ask for this. Do not reply.' : 'This message has scam warning signs. Check it before you send anything.', 'message');
  attention('Warning. This message looks like a scam. Do not send anything yet.', [400, 150, 400, 150, 400]);
  notify('Vouch: this message looks like a scam', 'Do not send anything yet. Open Vouch to check it.', 'local-scam');
  renderOverlay();
}

// Sends the check for whatever is in the form. Throws Error(code) so callers can show friendly().
async function submitCheck() {
  const F = S.form;
  const cents = parseCents(F.amount);
  if (!cents) throw new Error('NEED_AMOUNT');
  if (!F.friendId || !friendById(F.friendId)) throw new Error('NEED_FRIEND');
  if (!isLinked(friendById(F.friendId))) throw new Error('NOT_PAIRED');
  const body = { claimedId: F.friendId, amountCents: cents, method: F.method, channel: F.channel };
  const sent = F.text.trim();
  if (sent) body.text = sent;
  if (F.image) body.imageDataUrl = F.image;
  const { requestId } = await call('verify:request', body);
  if (sent) S.texts.set(requestId, sent); // kept in this tab's memory only
  S.current = requestId;
  S.waitSince = Date.now();
  if (S.friends.length > 1) { F.friendId = ''; F.friendPicked = false; } // the next check asks who again
  Object.assign(F, { text: '', amount: '', image: '', amountTouched: false, methodTouched: false });
  return requestId;
}

// While the friend's phone has not answered, say how long is left (the server gives up after 2 minutes).
const WAIT_MS = 120000;
function tickWait() {
  const el = document.getElementById('waitleft');
  const u = S.results.get(S.current);
  const waiting = !u || (u.stages && u.stages.confidence && u.stages.confidence.answer === 'none');
  if (!el || !waiting || !S.waitSince) return;
  const left = Math.max(0, Math.ceil((S.waitSince + WAIT_MS - Date.now()) / 1000));
  const name = u && u.stages ? u.stages.information.claimedName : 'their phone';
  el.textContent = left > 0 ? `Waiting for ${name === 'their phone' ? name : `${name}'s phone`}… ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'Still waiting. Do not send anything yet.';
}

// The Check screen has one job: paste what you got, see what Vouch makes of it, and ask their phone. It works with nobody linked
// too (the warning and the AI read need no friend), so anyone can try it alone; asking a phone needs someone linked.
function checkView() {
  const F = S.form;
  const hasFriends = S.friends.length > 0;
  // Never guess between several trusted people: with one it is them; with more, the message's own words can name one (it says
  // "it's Varsha"), and otherwise the person picks.
  if (F.friendId && !friendById(F.friendId)) F.friendId = '';
  if (S.friends.length === 1) F.friendId = S.friends[0].id;
  const readKey = () => `${F.text}|${F.image ? F.image.length : 0}`; // declared before paintFlags() first runs (it was a "before initialization" crash)

  const flags = h('div', { 'aria-live': 'polite' });
  const paintFlags = () => {
    const s = suggest(F.text);
    const ai = F.aiRead && F.aiRead.key === readKey() ? F.aiRead.read : null;
    const useAi = !!(ai && ai.title && ai.title !== 'Nothing stands out');
    const g = useAi ? ai : classify(F.text);
    const kids = [];
    if (g) kids.push(guideCard(g, useAi));
    if (!useAi && s.tags.length) kids.push(h('div', { class: 'flagbar' }, ...s.tags.map((t) => h('span', { class: 'chip' }, TAGS[t]))));
    flags.replaceChildren(...kids);
  };
  const text = h('textarea', { id: 'text', maxlength: '2000', placeholder: 'Paste the message you received', 'aria-label': 'The message you received', oninput: () => onText() });
  const amount = h('input', { id: 'amount', inputmode: 'decimal', placeholder: 'For example 60', oninput: () => { F.amount = amount.value; F.amountTouched = true; paintSummary(); } });
  const methodChoice = choice('How do they want it?', METHODS.map(([k, t]) => [k, t, METHOD_LOGOS[k]]), F.method,
    (v) => { F.method = v; F.methodTouched = true; paintSummary(); }, 'two');
  text.value = F.text; amount.value = F.amount;
  function onText() {
    F.text = text.value;
    const s = suggest(F.text);
    if (s.amount && !F.amountTouched) { F.amount = s.amount; amount.value = s.amount; }
    if (s.method && !F.methodTouched) { F.method = s.method; methodChoice.setValue(s.method); }
    nameFromText();
    paintFlags();
    paintSummary();
    scheduleRead();
  }
  function nameFromText() {
    if (S.friends.length < 2 || F.friendPicked) return;
    const named = S.friends.filter((f) => f.name && new RegExp('\\b' + f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(F.text));
    const id = named.length === 1 ? named[0].id : '';
    if (id !== F.friendId) { F.friendId = id; paintWho(); paintSummary(); paintBtn(); }
  }
  paintFlags();

  // The instant AI read: a moment after the text stops changing, ask the server's AI what it makes of it and show it right here.
  // The on-phone guide above has already answered; this adds the AI's view when there is one.
  const aiLine = h('div', { 'aria-live': 'polite' });
  let readTimer = null; let readSeq = 0;
  function scheduleRead() {
    clearTimeout(readTimer);
    if (!S.watch || (F.text.trim().length < 12 && !F.image)) { readSeq += 1; aiLine.replaceChildren(); return; }
    readTimer = setTimeout(async () => {
      const mine = ++readSeq;
      aiLine.replaceChildren(h('p', { class: 'muted' }, 'AI is reading it…'));
      try {
        const r = await call('watch:read', { text: F.text, imageDataUrl: F.image || undefined }, 15000);
        if (mine !== readSeq) return;
        F.aiRead = r.ai && r.read ? { key: readKey(), read: r.read } : null;
        aiLine.replaceChildren();
        paintFlags();
      } catch { if (mine === readSeq) aiLine.replaceChildren(); }
    }, 700);
  }
  scheduleRead();

  const msg = h('div', { role: 'alert' });
  // Optional screenshot (a fake invoice, a payment page, a chat). Shrunk on this phone; analysed, never saved.
  const preview = h('div');
  const paintShot = () => preview.replaceChildren(...(F.image ? [
    h('img', { class: 'thumb', src: F.image, alt: 'The screenshot you added' }),
    h('button', { class: 'ghost', onclick: () => { F.image = ''; shot.value = ''; paintShot(); paintFlags(); scheduleRead(); } }, 'Remove the screenshot')] : []));
  const shot = h('input', { id: 'shot', type: 'file', accept: 'image/*', class: 'hidefile', 'aria-label': 'Attach a screenshot', onchange: async () => {
    const file = shot.files && shot.files[0];
    if (!file) return;
    try { F.image = await readScreenshot(file); msg.replaceChildren(); } catch (e) { F.image = ''; msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    paintShot();
    paintFlags();
    scheduleRead(); // the AI looks at the picture as soon as it is chosen
  } });
  paintShot();
  const attach = h('button', { class: 'ghost', onclick: () => shot.click() }, 'Attach a screenshot');
  const paste = h('button', { class: 'ghost', onclick: async () => {
    try {
      const clip = (await navigator.clipboard.readText()).slice(0, 2000);
      if (!clip.trim()) { msg.replaceChildren(h('p', { class: 'err' }, 'Nothing copied yet. Copy the message first, then tap Paste.')); return; }
      text.value = clip; onText(); msg.replaceChildren(); flashIfRisky();
    } catch { msg.replaceChildren(h('p', { class: 'err' }, 'Your phone blocked that. Press and hold in the box, then tap Paste.')); }
  } }, 'Paste');
  const example = h('button', { class: 'ghost', onclick: () => {
    Object.assign(F, { channel: 'text', amountTouched: false, methodTouched: false, amount: '', method: 'venmo_cashapp_zelle',
      text: "hey it's me, new number! I'm stuck at the store and my card got declined. Can you buy $200 in Apple gift cards right now? Please don't tell mom, I'll pay you back tonight." });
    const s = suggest(F.text);
    F.amount = s.amount; if (s.method) F.method = s.method;
    renderMain();
    flashIfRisky();
  } }, 'Try an example');

  // What Vouch understood, in one line. The three details behind it (who, how they got in touch, amount, how to pay) are only
  // opened when something is missing, so the normal path is: paste, then tap one button.
  const summary = h('p', { class: 'big', id: 'checksummary' });
  const friend = () => friendById(F.friendId);
  function paintSummary() {
    const cents = parseCents(F.amount);
    summary.textContent = hasFriends
      ? (cents ? `${friend() ? friend().name : 'They'} wants ${fmt(cents)} by ${label(METHODS, F.method).toLowerCase()}.` : 'How much do they want? Add it below.')
      : '';
  }
  paintSummary();
  const whoBox = h('div');
  function paintWho() {
    whoBox.replaceChildren(...(S.friends.length > 1 ? [people('Who does it say it is?', F.friendId, (id) => { F.friendId = id; F.friendPicked = true; msg.replaceChildren(); paintWho(); paintSummary(); paintBtn(); })] : []));
  }
  paintWho();
  const channel = choice('How did they reach you?', CHANNELS.map(([k, t]) => [k, t, CHANNEL_LOGOS[k]]), F.channel, (v) => { F.channel = v; }, 'two');
  const details = h('details', { class: 'more', ...(parseCents(F.amount) ? {} : { open: true }) }, h('summary', null, 'Change the details'),
    channel, h('label', { for: 'amount' }, 'How much do they want? ($)'), amount, methodChoice);

  const btn = h('button', { onclick: async () => {
    btn.disabled = true;
    msg.replaceChildren();
    try {
      await submitCheck();
      renderMain();
      document.getElementById('result')?.scrollIntoView({ block: 'start' });
    } catch (e) { details.open = true; msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    btn.disabled = false;
  } }, 'Ask their phone');
  function paintBtn() { btn.textContent = friend() ? `Ask ${friend().name}'s phone` : (S.friends.length > 1 ? 'Ask their phone' : 'Check now'); }
  paintBtn();

  const ask = hasFriends
    ? [whoBox, summary, details, msg, btn]
    : [h('button', { onclick: () => setTab('friends') }, 'Add someone to ask their phone')];

  return h('section', null, topbar('Check a message'),
    text, h('div', { class: 'row' }, paste, attach), shot, preview, flags, aiLine,
    ...ask,
    h('div', { id: 'result', 'aria-live': 'polite' }),
    h('p', { class: 'muted' }, S.watch && S.watch.listen ? "Not saved by Vouch. If AI is on, the message is read by Google's Gemini." : 'Not saved by Vouch.'),
    example);
}

async function effective(u) {
  if (u.verdict !== 'green') return u;
  const f = friendById(u.claimedId);
  if (f && await verifyAnswer(u, f.signPub)) return u;
  return { ...u, verdict: 'red', reasons: ["Signature didn't check out"] };
}

async function onUpdate(u) {
  if (!u || u.checkerId !== (S.me && S.me.id)) return;
  S.results.set(u.requestId, await effective(u));
  if (!S.current) S.current = u.requestId;
  if (S.current === u.requestId) { renderResult(); announce(S.results.get(u.requestId)); }
}

function announce(u) {
  const conf = u.stages.confidence || {};
  const key = `${u.verdict}:${conf.answer}`;
  if (S.announced.get(u.requestId) === key) return;
  S.announced.set(u.requestId, key);
  const name = u.stages.information.claimedName;
  if (u.verdict === 'red') {
    S.queue.push({ kind: 'alert', data: { u, soft: false } });
    raiseAlert(2, conf.answer === 'not_me' ? `${name} says this was NOT them.` : 'Something does not add up.', `req-${u.requestId}`);
    const line = `Stop. Do not send money. ${conf.answer === 'not_me' ? `${name} says this was not them.` : 'Something does not add up.'}`;
    attention(line, [400, 150, 400, 150, 400], 'stop');
    notify('Vouch: do not send money', conf.answer === 'not_me' ? `${name} says this was not them.` : 'Something does not add up.', `res-${u.requestId}`);
  } else if (u.verdict === 'amber' && conf.answer === 'timeout') {
    S.queue.push({ kind: 'alert', data: { u, soft: true } });
    raiseAlert(1, `${name} has not answered. Do not send yet.`, `req-${u.requestId}`);
    attention(`Wait. ${name} has not answered. Do not send money yet.`, [300, 150, 300], 'wait');
    notify('Vouch: wait', `${name} has not answered yet.`, `res-${u.requestId}`);
  } else if (u.verdict === 'amber') {
    raiseAlert(1, (u.reasons && u.reasons[0]) || 'Wait for confirmation before you send anything.', `req-${u.requestId}`);
  } else if (u.verdict === 'green') {
    clearAlert();
    attention(`Verified. ${name} confirmed this on their own phone.`, 80, 'ok');
    notify('Vouch: verified', `${name} confirmed this on their own phone.`, `res-${u.requestId}`);
  }
  renderOverlay();
}

function renderResult() {
  const box = document.getElementById('result');
  if (!box) return;
  if (!S.current) { box.replaceChildren(); return; } // nothing has been asked yet: show nothing (it used to say "Asking their phone…" on a fresh screen)
  const u = S.results.get(S.current);
  if (!u) { box.replaceChildren(h('p', { class: 'muted', id: 'waitleft', role: 'status' }, 'Asking their phone…')); tickWait(); return; }
  const info = u.stages.information;
  const und = u.stages.understanding || {};
  const conf = u.stages.confidence || {};
  const name = info.claimedName;
  const sent = S.texts.get(u.requestId);
  const tags = [...new Set([...(und.tags || []), ...(sent ? suggest(sent).tags : [])])];
  const title = { green: 'Verified. Safe to send.', amber: 'Wait.', red: 'Do not send.' }[u.verdict];
  const answerText = {
    none: `Waiting for ${name}'s phone…`, yes: `${name} confirmed on their own phone.`,
    not_me: `${name} says this was NOT them.`, timeout: `No reply from ${name}.`,
  }[conf.answer];
  const reasons = (u.reasons || []).length ? h('ul', null, u.reasons.map((r) => h('li', null, r))) : null;
  const thread = sent ? h('div', { class: 'thread' }, h('div', { class: 'from' }, name), h('div', { class: 'bubble' }, sent)) : null;
  const card = h('div', { class: 'card' },
    h('div', { class: 'stage' }, h('b', null, '1 · What they asked'),
      h('p', null, `${name} · ${fmt(info.amountCents)} · ${label(METHODS, info.method)} · ${label(CHANNELS, info.channel)}`),
      h('div', null, logos(METHOD_LOGOS[info.method]), logos(CHANNEL_LOGOS[info.channel]))),
    h('div', { class: 'stage' }, h('b', null, '2 · AI check'),
      und.explanation ? h('p', null, und.explanation) : null,
      tags.length ? tags.map((t) => h('span', { class: 'chip' }, TAGS[t] || t)) : h('p', null, 'Nothing stands out.'),
      und.paymentRisk ? h('p', null, `Payment risk: ${und.paymentRisk}`) : null,
      und.firstRequest ? h('p', null, `This is the first time ${name} has asked you for money.`) : null,
      h('p', { class: 'muted' }, `AI can warn. Only ${name}'s own phone can clear a request.`)),
    h('div', { class: 'stage' }, h('b', null, '3 · Did they confirm?'),
      h('p', { id: conf.answer === 'none' ? 'waitleft' : undefined }, answerText),
      // Once they have said it was not them, no word can change that, so don't ask for one.
      u.needs && u.needs.word && conf.answer !== 'not_me' ? h('p', null, conf.wordOk ? 'Shared word matched.' : 'Shared word still needed.') : null,
      conf.approvals && conf.approvals.needed ? h('p', null, `Second person: ${conf.approvals.received} of ${conf.approvals.needed}`) : null));
  const parts = [thread, h('div', { class: `verdict ${u.verdict}` }, h('h3', null, title), reasons), card];
  if (u.verdict === 'amber' && conf.answer === 'yes' && u.needs && u.needs.word && !conf.wordOk) parts.push(wordBox(u, name));
  box.replaceChildren(...parts.filter(Boolean));
}

function wordBox(u, name) {
  const f = friendById(u.claimedId);
  const input = h('input', { placeholder: 'e.g. acid acorn', autocapitalize: 'none', autocomplete: 'off', value: S.drafts[u.requestId] || '',
    oninput: () => { S.drafts[u.requestId] = input.value; } });
  const msg = h('div');
  const btn = h('button', { onclick: async () => {
    if (!f) return;
    if (await checkWord(f.wordKey, input.value)) {
      try { await call('verify:wordcheck', { requestId: u.requestId, passed: true }); } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    } else {
      msg.replaceChildren(h('p', { class: 'err' }, "That's not your shared word. Don't send money."));
    }
  } }, 'Check the word');
  return h('div', { class: 'card' }, h('b', null, 'Ask them on a call'),
    h('p', null, `Ask ${name}: "What's our word?" Type exactly what they say.`), input, btn, msg);
}

// ---------- on a call ----------
// One flow: tap "Listen to this call", put the call on speaker, and Vouch tells you when it hears a scam.
// Everything else (who is calling, a recording, typing what you hear) sits under "More ways".

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const callFriend = () => (S.callWith && S.callWith !== 'other' ? friendById(S.callWith) : null);

// The code word is generated on demand, like an authenticator app: tap to see it, it expires with the minute.
function revealWord() {
  if (!friendById(S.wordFriendId)) return;
  S.wordProblem = false;
  S.wordShown = true;
  S.wordExpired = false;
  S.wordMinute = Math.floor(Date.now() / 60000);
  paintWordArea();
  tickWord();
}

function callResult(ok) {
  const f = friendById(S.wordFriendId);
  if (!f) return;
  S.queue.push({ kind: 'call', data: { requestId: `call-${Date.now()}`, ok, name: f.name } });
  attention(ok ? `That's really ${f.name}.` : `No match. This is not ${f.name}. Hang up.`, ok ? 80 : [400, 150, 400, 150, 400]);
  notify(ok ? 'Vouch: word matched' : 'Vouch: NO MATCH', ok ? `That's really ${f.name}.` : `This is not ${f.name}. Hang up.`, 'call-check');
  renderOverlay();
}

// They're asking for money on the call: open the check, already set up for a call. The call screen steps aside.
function askAboutCall() {
  S.form.channel = 'call';
  const amt = callRisk(`${S.heard || ''} ${S.cur || ''}`).amount;
  if (amt && !S.form.amountTouched) S.form.amount = amt;
  if (S.listening) S.callMin = true;
  setTab('check');
}

function paintWordArea() {
  for (const id of ['wordarea', 'livewordarea']) paintWordInto(document.getElementById(id));
}

function paintWordInto(box) {
  const f = friendById(S.wordFriendId);
  if (!box || !f) return;
  if (S.wordProblem) {
    box.replaceChildren(h('p', { class: 'err' }, `Couldn't make a code word for ${f.name}. Open My people and link up with them again.`),
      h('button', { class: 'ghost', onclick: () => { S.wordProblem = false; revealWord(); } }, 'Try again'));
    return;
  }
  if (!S.wordShown) {
    box.replaceChildren(...[
      S.wordExpired ? h('p', { class: 'err' }, 'That word expired.') : null,
      h('button', { onclick: revealWord }, S.wordExpired ? 'Get a new word' : `Show the word for ${f.name}`),
    ].filter(Boolean));
    return;
  }
  const said = h('input', { placeholder: 'The two words they said', autocapitalize: 'none', autocomplete: 'off', 'aria-label': 'The two words they said' });
  const typedMsg = h('div', { role: 'alert' });
  box.replaceChildren(
    h('p', { class: 'muted', style: 'text-align:center' }, `Ask ${f.name}: "What's our word?" Don't say it first.`),
    h('div', { class: 'wordcard' },
      h('div', { class: 'ring', role: 'timer', 'aria-label': 'Time left for this word' }, h('span', { class: 'ringsec' }, '')),
      h('div', { class: 'bigword', id: 'bigword' }, '…')),
    h('div', { class: 'row' },
      h('button', { class: 'yes', onclick: () => callResult(true) }, 'It matches'),
      h('button', { class: 'no', onclick: () => callResult(false) }, "It doesn't match")),
    h('details', null, h('summary', null, 'Type what they said instead'), said,
      h('button', { class: 'ghost', onclick: async () => {
        if (!said.value.trim()) { typedMsg.replaceChildren(h('p', { class: 'err' }, 'Type the two words they said.')); return; }
        try { callResult(await checkWord(f.wordKey, said.value)); } catch { typedMsg.replaceChildren(h('p', { class: 'err' }, "Couldn't check that word. Try again.")); }
      } }, 'Check it'), typedMsg,
      h('p', { class: 'muted' }, 'If a real word never matches, check that both phones have automatic date and time.')));
}

// The call tab: pick who is calling (their name is the button), see the code word at once; and, separately, listen for scams.
function wordView() {
  const hasFriends = S.friends.length > 0;
  if (S.callWith && S.callWith !== 'other' && !friendById(S.callWith)) S.callWith = null; // that person was removed
  if (S.friends.length === 1 && !S.callWith) { S.callWith = S.friends[0].id; S.wordFriendId = S.callWith; }
  const f = callFriend();
  if (f) S.wordFriendId = f.id;
  const canServer = !!(S.watch && S.watch.listen);
  const L = S.listen || (S.listen = { mode: 'off', status: '', level: 0, words: 0 });

  const typed = h('textarea', { id: 'callsays', placeholder: 'Type or paste what the caller is saying', 'aria-label': 'What the caller is saying',
    oninput: () => {
      S.heard = typed.value; S.cur = '';
      if (!typed.value.trim()) { S.callLevel = 0; S.callAi = null; }
      S.listen.mode = typed.value.trim() ? 'typed' : 'off';
      paintListen();
      scanCall();
    } });
  typed.value = S.listening ? '' : (S.heard || '');
  const rec = canServer ? h('input', { type: 'file', id: 'recfile', accept: 'audio/*', 'aria-label': 'Pick a recording to analyze',
    onchange: () => { const file = rec.files && rec.files[0]; if (file) analyzeRecording(file); } }) : null;

  queueMicrotask(() => { paintWordArea(); tickWord(); paintListen(); });

  const pick = (id) => {
    S.callWith = id; S.wordShown = false; S.wordExpired = false; S.wordProblem = false;
    if (id !== 'other') S.wordFriendId = id;
    renderMain();
    if (id !== 'other') revealWord();
  };
  const who = hasFriends ? people('Who is calling?', S.callWith, pick, { other: true }) : null;
  const word = f ? h('div', { id: 'wordarea' })
    : S.callWith === 'other' ? h('div', { class: 'card' }, h('p', { class: 'big' }, "They're not on your list."), h('p', null, 'Hang up and call them back on a number you already have.'))
      : hasFriends ? null
        : h('button', { onclick: () => setTab('friends') }, 'Add someone to get a code word');

  const listen = S.listening
    ? [h('p', { id: 'listenstatus', role: 'status', 'aria-live': 'polite' }, L.status),
      h('button', { class: 'bigbtn', onclick: () => { S.callMin = false; renderOverlay(); } }, 'Open the call screen'),
      h('button', { class: 'ghost', onclick: stopListening }, 'Stop listening')]
    : [h('button', { class: 'bigbtn', onclick: startListening }, 'Listen for scams'),
      h('p', { class: 'muted' }, 'Put the call on speaker first.'),
      L.status ? h('p', { class: 'err', role: 'alert' }, L.status) : null,
      L.status ? h('button', { class: 'ghost', onclick: () => { S.openMore = true; renderMain(); } }, 'Type what you hear instead') : null];

  return h('section', null, topbar('On a call'), who, word, ...listen,
    f ? h('button', { class: 'ghost', onclick: askAboutCall }, "They're asking me for money") : null,
    h('details', { class: 'more', ...(S.openMore ? { open: true } : {}) }, h('summary', null, 'More'),
      rec ? h('div', null, h('label', { for: 'recfile' }, 'Analyze a recording'), rec) : null,
      h('label', { for: 'callsays' }, 'Or type what you hear'), typed, h('div', { id: 'listenguide' }),
      h('p', { class: 'muted' }, "The browser's speech service or the Vouch server may process the audio; nothing is saved. Tell the other person you're using it.")));
}

const setVar = (el, name, value) => { if (el.style.setProperty) el.style.setProperty(name, String(value)); else el.style[name] = value; };

async function tickWord() {
  if (!S.wordShown) return;
  const f = friendById(S.wordFriendId);
  if (!f) return;
  let cw;
  try { cw = await currentWord(f.wordKey); } catch { S.wordShown = false; S.wordProblem = true; paintWordArea(); return; } // a missing or damaged key
  const { word, minute, secondsLeft } = cw;
  if (minute !== S.wordMinute) { S.wordShown = false; S.wordExpired = true; paintWordArea(); return; }
  for (const el of document.querySelectorAll('.bigword')) {
    if (el.textContent !== word) { el.textContent = word; el.classList.add('fresh'); }
  }
  // The ring runs down with the minute and turns amber, then red, so the person sees the word is about to change.
  for (const el of document.querySelectorAll('.ring')) {
    setVar(el, '--p', secondsLeft / 60);
    el.className = `ring${secondsLeft <= 8 ? ' late' : secondsLeft <= 20 ? ' warn' : ''}`;
  }
  for (const el of document.querySelectorAll('.ringsec')) el.textContent = `${secondsLeft}s`;
}

// ---------- watch a call ----------
// Three ways in, chosen for you:
//   1. the browser's own speech recognition (fast, live words), or
//   2. short audio chunks sent to the Vouch server, which writes down what was said and judges the call in one go
//      (used on iPhone, where the browser's recognition is unreliable, and as the automatic fallback), or
//   3. a recording you pick, played and analysed in real time by the same server path.
// The words are scanned on this phone and nothing is saved. The phone never speaks during a call (its own voice would be heard).

const speechCtor = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const RISK_TEXT = ['Nothing suspicious so far', 'Someone is asking for money', 'STOP. Scam signs'];

function paintListen() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const L = S.listen || {};
  const heard = `${S.heard || ''} ${S.cur || ''}`.trim();
  const level = S.callLevel || 0;
  set('listenstatus', L.status || ''); set('lv-status', L.status || '');
  setWave(L.level || 0);
  const c = S.callAi || classify(heard);
  for (const id of ['listenguide', 'lv-guide']) {
    const g = document.getElementById(id);
    if (!g) continue;
    // On the call screen show the guide only once there is something to say.
    g.replaceChildren(...(c && (id === 'listenguide' || level >= 1) ? [guideCard(c, !!S.callAi)] : []));
  }
  const cap = document.getElementById('lv-cap');
  if (cap) cap.replaceChildren(...(heard ? highlight(heard.slice(-240)).map((p) => (p.hit ? h('mark', null, p.text) : p.text)) : [h('span', { class: 'dim' }, L.mode === 'recording' ? 'Playing the recording…' : 'Listening… words will appear here.')]));
  const risk = document.getElementById('lv-risk');
  if (risk) { risk.textContent = RISK_TEXT[level]; risk.className = `riskbadge r${level}`; }
  const root = document.getElementById('livecall');
  if (root) root.className = `overlay live lv${level}`;
  tickCall();
}

// The bars on the call screen follow the microphone when the Vouch server is listening; with the browser's own engine there is no
// level to show, so they simply breathe to say that it is listening.
function setWave(level) {
  const w = document.getElementById('lv-wave');
  if (!w) return;
  const live = !!(S.listen && S.listen.mode === 'server');
  w.classList.toggle('idle', !live);
  const shape = [0.6, 0.9, 1, 0.85, 0.65];
  [...w.children].forEach((bar, i) => setVar(bar, '--lv', Math.min(1, 0.18 + level * shape[i] * 0.95)));
}

// The clock on the call screen and the "back to call" bar.
function tickCall() {
  if (!S.listening || !S.call) { const bar = document.getElementById('callbar'); if (bar && bar.children.length) bar.replaceChildren(); return; }
  const t = fmtClock(Date.now() - S.call.startedAt);
  const el = document.getElementById('lv-time');
  if (el) el.textContent = t;
  const bar = document.getElementById('callbar');
  if (bar) {
    if (S.callMin) {
      if (!bar.children.length) bar.append(h('div', { class: 'callbar' }, h('span', { id: 'cb-time' }, t), h('span', null, 'Vouch is listening to your call'),
        h('button', { onclick: () => { S.callMin = false; renderOverlay(); } }, 'Back to call')));
      else { const cb = document.getElementById('cb-time'); if (cb) cb.textContent = t; }
    } else if (bar.children.length) bar.replaceChildren();
  }
}

// The call screen: one status that turns amber and then red, what is being said (risky words marked), and two buttons.
function liveCallOverlay() {
  const f = callFriend();
  const level = S.callLevel || 0;
  const rec = S.listen && S.listen.mode === 'recording';
  const el = h('div', { id: 'livecall', class: `overlay live lv${level}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Listening to your call' },
    h('div', { class: 'inner' },
      h('div', { class: 'livetop' }, h('span', null, rec ? 'Analyzing a recording' : (f ? `Listening to your call with ${f.name}` : 'Listening to your call')),
        h('span', { class: 'calltime', id: 'lv-time' }, fmtClock(Date.now() - ((S.call && S.call.startedAt) || Date.now())))),
      h('div', { id: 'lv-risk', class: `riskbadge r${level}`, role: 'status', 'aria-live': 'assertive' }, RISK_TEXT[level]),
      h('div', { class: 'captions', id: 'lv-cap', 'aria-live': 'off' }),
      h('div', { id: 'lv-guide' }),
      f ? h('div', { id: 'livewordarea' }) : null,
      h('p', { class: 'livestatus', id: 'lv-status', role: 'status', 'aria-live': 'polite' }, (S.listen && S.listen.status) || ''),
      h('div', { class: 'wave idle', id: 'lv-wave', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(() => h('i'))),
      actions(h('button', { class: 'no', onclick: stopListening }, 'Stop listening'),
        quiet('Hide this screen (keeps listening)', () => { S.callMin = true; renderOverlay(); tickCall(); }))));
  queueMicrotask(() => { paintListen(); if (f) paintWordArea(); });
  return el;
}

// One session of watching. Everything about a call (clock, words, engine) is reset here.
function newCall(mode, status) {
  stopEngine();
  holdScreen();
  Object.assign(S, { heard: '', cur: '', callLevel: 0, listening: true, callMin: false, callAi: null, lastAiText: '' });
  S.call = { startedAt: Date.now() };
  S.listen = { mode, status, level: 0, words: 0 };
  S.stt = { q: [], busy: false, retries: 0 };
}

// Pick the engine for this phone: the server on iPhone (the browser's recognition is unreliable there), the browser elsewhere,
// and whichever is left if one isn't available.
function startListening() {
  if (S.listening) return; // a second tap must not start a second microphone
  const canServer = !!(S.watch && S.watch.listen);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  if (canServer && (ios || !speechCtor())) startServerListening();
  else if (speechCtor()) startBrowserListening();
  else {
    S.listen = { mode: 'off', status: "This browser can't listen to speech, and the Vouch server has no speech key. Open More ways and type what the caller says.", level: 0, words: 0 };
    renderMain();
  }
}

function startBrowserListening() {
  const SR = speechCtor();
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  newCall('browser', 'Listening. Put the call on speaker, close to the phone.');
  S.rec = rec;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += `${e.results[i][0].transcript} `;
    S.cur = text.slice(-1500);
    S.listen.words = `${S.heard} ${S.cur}`.trim().split(/\s+/).filter(Boolean).length;
    S.listen.status = 'Listening…';
    paintListen();
    scanCall();
  };
  rec.onerror = (e) => {
    const code = e && e.error;
    if (code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed') { fail('The microphone is blocked. Allow it in your browser settings, then try again.'); return; }
    if (S.watch && S.watch.listen) { switchToServer("The browser can't listen here. Switching to Vouch's listener…"); return; }
    fail(code === 'network' ? "The browser's speech service can't be reached. Open More ways and type what the caller says."
      : "Couldn't use the microphone. Some phones block it during a call; use a second phone next to the call, or open More ways and type what you hear.");
  };
  rec.onend = () => { // browsers end a session after a pause; start again while the person is still listening
    if (!S.listening || !S.listen || S.listen.mode !== 'browser' || S.rec !== rec) return;
    S.heard = `${S.heard} ${S.cur}`.slice(-1500); S.cur = '';
    try { rec.start(); } catch { /* already starting */ }
  };
  try { rec.start(); } catch (err) { fail("Couldn't start listening. Open More ways and type what the caller says."); return; }
  // If nothing comes through in a few seconds, don't wait around: hand over to the server's listener automatically.
  S.listen.timer = setTimeout(() => {
    if (S.listening && S.listen.mode === 'browser' && S.listen.words === 0 && S.watch && S.watch.listen) switchToServer('Not hearing anything with the browser. Switching to Vouch\'s listener…');
  }, 7000);
  paintStatus();
  renderMain();
}

function switchToServer(status) {
  const started = S.call && S.call.startedAt;
  const heard = S.heard;
  stopEngine();
  startServerListening();
  if (S.call && started) S.call.startedAt = started; // the clock keeps running across the switch
  if (heard) S.heard = heard;
  if (status && S.listen) { S.listen.status = status; paintListen(); }
}

// Ship audio to the server in order, never dropping a chunk while another is being worked on.
function enqueueWav(wav) {
  const t = S.stt;
  if (!t) return;
  if (t.q.length >= 5) t.q.shift(); // a long backlog means we are behind; keep the freshest
  t.q.push(wav);
  pumpStt();
}

async function pumpStt() {
  const t = S.stt;
  if (!t || t.busy) return;
  t.busy = true;
  try {
    while (t.q.length && S.listening && S.stt === t) {
      const wav = t.q.shift();
      try {
        // One request: the server writes down what was said and judges the call so far.
        const r = await call('watch:listen', { wav, prior: (S.heard || '').slice(-700) }, 25000);
        t.retries = 0;
        if (r.text) {
          S.heard = `${S.heard} ${r.text}`.trim().slice(-1500);
          S.listen.words = S.heard.split(/\s+/).filter(Boolean).length;
          S.listen.status = S.listen.mode === 'recording' ? 'Analyzing the recording…' : 'Listening…';
        }
        if (r.ai && r.read) {
          S.callAi = r.read;
          S.lastAiText = S.heard; // the AI has just read exactly these words
          if (r.level > (S.callLevel || 0)) escalateCall(r.level, [], false, r.read);
        }
        scanCall();
      } catch (err) {
        const c = err && err.message;
        if (c === 'NO_STT') { fail("The Vouch server has no speech key, so it can't listen. Open More ways and type what the caller says."); return; }
        if (c === 'RATE_LIMITED' && t.retries < 3) { t.retries += 1; S.listen.status = 'Catching up. One moment…'; paintListen(); await new Promise((r) => setTimeout(r, 3000)); t.q.unshift(wav); }
        else if (c === 'OFFLINE') S.listen.status = "You're offline. Reconnecting…";
        else S.listen.status = "Couldn't turn that into words. Still listening.";
      }
      paintListen();
    }
    if (S.listening && S.stt === t && S.listen.mode === 'recording' && t.done && !t.q.length) {
      S.listen.status = 'Finished analyzing the recording.';
      paintListen();
    }
  } finally { t.busy = false; }
}

async function startServerListening() {
  newCall('server', 'Starting the microphone…');
  paintStatus();
  renderMain();
  const md = navigator.mediaDevices;
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!md || !md.getUserMedia || !Ctx) { fail("This browser can't use the microphone here. Open More ways and type what the caller says."); return; }
  let stream;
  try {
    // No echo cancelling or noise suppression: they can erase a call or clip that is playing on speaker nearby.
    stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  } catch (err) {
    fail(err && err.name === 'NotAllowedError' ? 'The microphone is blocked. Allow it in your browser settings, then try again.'
      : (err && err.name === 'NotFoundError' ? 'No microphone found. Open More ways and type what the caller says.' : "Couldn't use the microphone. Open More ways and type what the caller says."));
    return;
  }
  if (!S.listening) { stream.getTracks().forEach((t) => t.stop()); return; }
  const ctx = new Ctx();
  try { if (ctx.resume) await ctx.resume(); } catch { /* fine */ }
  if (!ctx.createScriptProcessor) { stream.getTracks().forEach((t) => t.stop()); fail("This browser can't capture audio. Open More ways and type what the caller says."); return; }
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  let chunks = []; let samples = 0;
  const flush = () => {
    const mine = chunks; chunks = []; samples = 0;
    const { wav, rms } = chunkToWav(mine, ctx.sampleRate);
    if (rms < 0.002) { S.listen.status = 'No sound picked up yet. Is the call on speaker, with the volume up?'; paintListen(); return; }
    enqueueWav(wav);
  };
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d); samples += d.length;
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    S.listen.level = Math.min(1, Math.sqrt(sum / d.length) * 8);
    setWave(S.listen.level);
    if (samples >= ctx.sampleRate * 5) flush();
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  S.audio = { stream, ctx, proc, src };
  S.listen.status = 'Listening. Put the call on speaker.';
  paintListen();
}

// Play a recording (a voicemail, an audio clip) and analyse it as it plays, exactly like a live call.
async function analyzeRecording(file) {
  if (!(S.watch && S.watch.listen)) { toast("Analyzing a recording needs the Vouch server's speech key."); return; }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) { toast("This browser can't read audio files."); return; }
  newCall('recording', 'Reading the recording…');
  paintStatus();
  renderMain();
  let data; let rate;
  try {
    const ctx = new Ctx();
    const buf = await file.arrayBuffer();
    const audio = await new Promise((resolve, reject) => { const p = ctx.decodeAudioData(buf, resolve, reject); if (p && p.then) p.then(resolve, reject); });
    rate = audio.sampleRate;
    data = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < audio.length; i++) data[i] += d[i] / audio.numberOfChannels; }
    try { ctx.close(); } catch { /* fine */ }
  } catch { fail("Couldn't read that recording. Try an mp3, m4a or wav file."); return; }
  if (!S.listening || S.listen.mode !== 'recording') return;
  const url = URL.createObjectURL(file);
  const player = new Audio(url);
  S.player = { audio: player, url };
  try { player.play().catch(() => {}); } catch { /* silent playback is fine; the analysis still runs */ }
  S.call.startedAt = Date.now();
  S.listen.status = 'Playing and analyzing the recording…';
  paintListen();
  const win = Math.round(rate * 5);
  const total = Math.max(1, Math.ceil(data.length / win));
  const t = S.stt;
  S.recTimers = [];
  for (let i = 0; i < total; i++) {
    const at = Math.min((i + 1) * 5000, Math.ceil((data.length / rate) * 1000) + 300);
    S.recTimers.push(setTimeout(() => {
      if (!S.listening || S.stt !== t) return;
      const { wav, rms } = chunkToWav([data.subarray(i * win, Math.min(data.length, (i + 1) * win))], rate);
      if (rms >= 0.001) enqueueWav(wav);
      if (i === total - 1) { t.done = true; pumpStt(); }
    }, at));
  }
}

// A locked phone stops listening, so ask it to keep the screen on while a call is being watched (where the browser allows it).
async function holdScreen() {
  try { if (navigator.wakeLock && !S.wake) S.wake = await navigator.wakeLock.request('screen'); } catch { /* not allowed: the call still works */ }
}
function releaseScreen() {
  try { if (S.wake) S.wake.release(); } catch { /* already released */ }
  S.wake = null;
}

function stopEngine() {
  releaseScreen();
  if (S.listen && S.listen.timer) clearTimeout(S.listen.timer);
  for (const id of S.recTimers || []) clearTimeout(id);
  S.recTimers = [];
  const pl = S.player; S.player = null;
  if (pl) { try { pl.audio.pause(); } catch { /* fine */ } try { URL.revokeObjectURL(pl.url); } catch { /* fine */ } }
  const rec = S.rec; S.rec = null;
  try { if (rec) { rec.onend = null; rec.stop(); } } catch { /* already stopped */ }
  const a = S.audio; S.audio = null;
  if (a) {
    try { a.proc.disconnect(); a.src.disconnect(); } catch { /* fine */ }
    try { a.stream.getTracks().forEach((t) => t.stop()); } catch { /* fine */ }
    try { a.ctx.close(); } catch { /* fine */ }
  }
  S.stt = null;
}

function fail(message) {
  stopEngine();
  S.listening = false; S.callLevel = 0;
  S.listen = { mode: 'off', status: message, level: 0, words: 0 };
  if (A.source === 'call') clearAlert();
  paintStatus();
  renderMain();
}

function stopListening() {
  stopEngine();
  S.listening = false;
  S.heard = ''; S.cur = ''; S.callMin = false; S.callLevel = 0; S.callAi = null; S.lastAiText = ''; // the next call starts calm, so it can warn again
  S.listen = { mode: 'off', status: '', level: 0, words: 0 };
  if (A.source === 'call') clearAlert();
  paintStatus();
  renderMain();
}

// 0 = nothing; 1 = someone is asking for money (check who it is); 2 = asking for money with scam warning signs.
function scanCall() {
  const r = callRisk(`${S.heard || ''} ${S.cur || ''}`);
  aiScanCall(); // the AI reads the same words a moment later and can raise this itself
  if (r.level <= (S.callLevel || 0)) return;
  escalateCall(r.level, r.tags, r.institution, null);
}

// Warn about the call at a given level. While the call screen is up the screen itself turns amber or red, with vibration and no
// spoken words (the phone's own voice would be picked up by its microphone). Otherwise a full-screen warning appears.
function escalateCall(level, tags, institution, ai) {
  S.callLevel = level;
  const onCallScreen = S.listening && !S.callMin;
  if (!onCallScreen) S.queue.push({ kind: 'callscam', data: { requestId: `callscam-${level}-${Date.now()}`, level, tags, institution, ai } });
  raiseAlert(level, level === 2 ? 'This call has scam warning signs.' : 'Someone on this call is asking for money.', 'call');
  attention(level === 2 ? 'Stop. This call has scam warning signs. Do not send anything.' : 'Someone on this call is asking for money. Make sure it is really them.',
    level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300], level === 2 ? 'call' : undefined);
  notify(level === 2 ? 'Vouch: this call looks like a scam' : 'Vouch: this call asks for money', 'Open Vouch and ask for your code word.', 'callscam');
  // Also tell the alert bot, so the person is messaged on their linked apps (and their family if it is serious).
  if (S.watch) {
    const g = ai || classify(`${S.heard || ''} ${S.cur || ''}`);
    call('watch:alert', { level, title: g ? g.title : 'a call' }, 4000).catch(() => {});
  }
  if (ai) S.callAi = ai;
  paintListen();
  renderOverlay();
}

// The AI's read of the call so far, for the browser and typed paths (the server path gets it in the same request as the words).
let aiCallAt = 0;
let aiCallBusy = false;
async function aiScanCall() {
  if (!S.watch || aiCallBusy || Date.now() - aiCallAt < 4000) return;
  const heard = `${S.heard || ''} ${S.cur || ''}`.trim();
  if (heard.length < 25 || heard === S.lastAiText) return;
  const session = S.call && S.call.startedAt;
  aiCallBusy = true; aiCallAt = Date.now(); S.lastAiText = heard;
  try {
    const r = await call('watch:read', { text: heard.slice(-900) }, 9000);
    if (session !== (S.call && S.call.startedAt)) return; // a different call by now
    if (r.ai && r.read) {
      S.callAi = r.read;
      paintListen();
      if (r.level > (S.callLevel || 0)) escalateCall(r.level, r.tags || [], false, r.read);
    }
  } catch { /* the instant rules already answered */ } finally { aiCallBusy = false; }
}

function callScamOverlay({ level, tags, institution, ai }) {
  const f = institution ? null : likelyFriend(); // an "institution" has no code word
  const anyone = !institution && S.friends.length > 0;
  const hard = level === 2;
  const guide = ai || classify(`${S.heard || ''} ${S.cur || ''}`);
  return h('div', { class: `overlay alert${hard ? '' : ' soft'}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Scam warning' },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, hard ? 'STOP. This call looks like a scam.' : 'Someone is asking for money.'),
      ai ? h('p', { class: 'sender' }, ai.title) : null,
      ...scamBody(guide, ai && ai.signals, ai && ai.impersonating, tags),
      // One main thing to do: make sure it is really them. The code word comes first, because it works on a live call.
      actions(anyone ? h('button', { onclick: () => { dismiss(); if (f) { S.callWith = f.id; S.wordFriendId = f.id; setTab('word'); revealWord(); } else setTab('word'); } }, f ? `Ask ${f.name} for our code word` : 'Check the code word') : null,
        anyone ? h('button', { class: 'ghost', onclick: () => { dismiss(); askAboutCall(); } }, f ? `Check with ${f.name}'s phone` : "Check with a trusted person's phone") : null,
        quiet(S.listening ? 'Keep listening' : 'Close', dismiss))));
}

// ---------- my people + pairing ----------

// iPhone Safari can erase the saved keys of a website it thinks is unused; an app on the Home Screen is kept.
function installCard() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  const standalone = navigator.standalone === true || (globalThis.matchMedia && globalThis.matchMedia('(display-mode: standalone)').matches);
  if (!ios || standalone) return null;
  return h('div', { class: 'card' }, h('b', null, 'Keep Vouch on this iPhone'),
    h('p', null, 'Safari can erase the saved keys of a website you have not opened for a while. An app on your Home Screen is kept. Tap Share, then Add to Home Screen, and open Vouch from there.'));
}

// The message bot: forward any message from any app, get the answer there, and a warning flashes in this app.
async function loadWatch() {
  try { S.watch = await call('watch:status', {}, 3000); } catch { S.watch = null; } // null: this server has no Watch service
}
async function loadSenders() {
  try { S.senders = (await call('watch:senders', {}, 3000)).senders; } catch { S.senders = null; }
}

// Who has been flagged for sending this account scam messages: a name or username, a count and the kind of scam. Never the message.
function sendersCard() {
  const list = S.senders || [];
  return h('div', null,
    list.length ? h('div', null, ...list.map((s) => h('div', { class: 'approw' },
      h('div', { class: 'apphead' },
        h('div', { class: 'appname' }, h('b', null, s.handle || s.name || 'Unknown sender'),
          h('span', { class: 'muted' }, `${s.name && s.handle ? `${s.name} · ` : ''}${SOURCE_APP[s.channel] || s.channel} · flagged ${s.flags} time${s.flags === 1 ? '' : 's'}${s.lastTitle ? ` · ${s.lastTitle}` : ''}`)),
        h('span', { class: s.maxLevel === 2 ? 'err' : 'muted' }, s.maxLevel === 2 ? 'Scam signs' : 'Asked for money')),
      h('button', { class: 'ghost', onclick: async () => { try { await call('watch:forget', { id: s.id }); await loadSenders(); renderMain(); } catch (e) { toast(friendly(e)); } } }, 'Forget this sender'))))
      : h('p', { class: 'muted' }, 'No one has been flagged yet.'),
    h('p', { class: 'muted' }, "Flagged by software, so it may be wrong. Vouch keeps only a name or username, a count and the kind of scam for 30 days, never the message. Telegram hides the sender when someone turns off forwarding, and then Vouch can't track them."));
}
const APP_LOGOS = { telegram: ['telegram'], sms: ['imessage', 'googlemessages'], whatsapp: ['whatsapp'] };

// One tap to connect: each link opens the app with the right chat and the code already filled in.
function connectLink(c, code) {
  const num = String(c.handle).replace(/[^\d+]/g, '');
  if (c.id === 'telegram') return { href: `https://t.me/${String(c.handle).replace('@', '')}?start=link_${code}`, label: 'Open Telegram', manual: `/link ${code}` };
  if (c.id === 'whatsapp') return { href: `https://wa.me/${num.replace('+', '')}?text=${encodeURIComponent(`link ${code}`)}`, label: 'Open WhatsApp', manual: `link ${code}` };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  return { href: `sms:${num}${ios ? '&' : '?'}body=${encodeURIComponent(`link ${code}`)}`, label: 'Open Messages', manual: `link ${code}` };
}

async function connectApp(c) {
  try { S.linkCode = { ...(await call('watch:link', {}, 5000)), channel: c.id }; renderMain(); } catch (e) { toast(friendly(e)); }
}

function connectPanel(c) {
  const l = connectLink(c, S.linkCode.code);
  return h('div', { class: 'connect' },
    h('p', null, `Tap below, then press ${c.id === 'telegram' ? 'Start' : 'Send'} in ${c.name}.`),
    h('a', { class: 'btnlink', href: l.href, target: '_blank', rel: 'noopener' }, l.label),
    h('p', { class: 'muted' }, `Or send this yourself: ${l.manual}`),
    h('p', { class: 'muted' }, 'This code works once, for 10 minutes.'));
}

// The apps this server is really connected to. Forward a suspicious message from any app and the warning comes back here.
function appsCard() {
  const W = S.watch;
  if (W === undefined) return h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Checking…'));
  if (!W || !W.channels || !W.channels.length) {
    return h('div', { class: 'card' }, h('p', null, 'Messaging apps are not connected on this server yet.'),
      h('p', { class: 'muted' }, 'Once they are, forward any suspicious message from any app and Vouch warns you here.'));
  }
  return h('div', { class: 'card' }, ...W.channels.map((c) => {
    const linked = (W.linked || []).includes(c.id);
    const panel = !linked && S.linkCode && S.linkCode.channel === c.id ? connectPanel(c) : null;
    return h('div', { class: 'approw' },
      h('div', { class: 'apphead' }, logos(APP_LOGOS[c.id]),
        h('div', { class: 'appname' }, h('b', null, c.name), h('span', { class: 'muted' }, c.handle)),
        h('span', { class: linked ? 'ok' : 'muted' }, linked ? 'Connected' : 'Not connected')),
      panel,
      linked
        ? h('button', { class: 'ghost', onclick: async () => { try { await call('watch:unlink', { channel: c.id }); await loadWatch(); renderMain(); } catch (e) { toast(friendly(e)); } } }, 'Disconnect')
        : (panel ? null : h('button', { onclick: () => connectApp(c) }, 'Connect')));
  }));
}
function alertsCard() {
  if (!('Notification' in globalThis)) return h('p', { class: 'muted' }, 'This browser cannot show alerts. Keep Vouch open.');
  const p = Notification.permission;
  if (p === 'granted') return h('p', null, 'Alerts are on. You get a notification when someone asks you to confirm a request.');
  if (p === 'denied') return h('p', { class: 'muted' }, 'Alerts are blocked. Turn them on for this site in your browser settings.');
  return h('div', null,
    h('p', null, 'Get a notification when a friend needs you to confirm a request, even if Vouch is in the background.'),
    h('p', { class: 'muted' }, 'On iPhone: tap Share, then Add to Home Screen, and open Vouch from there first.'),
    h('button', { onclick: requestAlerts }, 'Turn on alerts'));
}
// How a real message gets into Vouch. A web app can't read your Messages app, so you hand it the message.
function shareCard() {
  return h('div', null,
    h('p', null, 'Got a message asking for money? Hand it to Vouch and it warns you right away.'),
    h('p', { class: 'muted' }, 'Sharing opens Vouch with the message in the web address. Your phone clears it right away, but the web host can see it in its logs. Copy and paste avoids this.'),
    h('p', null, h('b', null, 'Any phone: '), 'copy the message, open Vouch, tap Check a message, then Paste the message.'),
    h('p', null, h('b', null, 'Android: '), 'install Vouch (browser menu, Install app). Then press and hold a message, tap Share, and choose Vouch.'),
    h('details', null, h('summary', null, 'iPhone: add Vouch to the Share sheet (1 minute, once)'),
      h('ol', { class: 'steps' },
        h('li', null, 'Open the Shortcuts app, tap +, and name it "Check with Vouch".'),
        h('li', null, 'Tap the info button and turn on Show in Share Sheet. Allow Text only.'),
        h('li', null, 'Add the action URL Encode and set it to the Shortcut Input.'),
        h('li', null, `Add the action Text. Type ${location.origin}/?text= and then insert the URL Encoded Text.`),
        h('li', null, 'Add the action Open URLs and give it that Text.'),
        h('li', null, 'Now select text in any app, tap Share, and choose Check with Vouch.'))));
}

function requestAlerts() {
  try { Notification.requestPermission().then(() => renderMain()); } catch { /* not supported */ }
}

function friendsView() {
  const list = S.friends.length
    ? h('div', { class: 'card' }, S.friends.map((f) => h('div', null,
      h('div', { class: 'friend' }, h('span', null, f.name),
        h('span', { class: isLinked(f) ? 'muted' : 'err' }, isLinked(f) ? 'Linked' : 'Not connected')),
      isLinked(f) ? null : h('p', { class: 'muted' }, 'The server lost this link. Your code word still works. Tap Add someone and link up again.'),
      S.removeAsk === f.id
        ? h('div', { class: 'row' },
          h('button', { class: 'no', onclick: async () => { await store.deleteFriend(f.id); S.friends = await store.listFriends(); S.removeAsk = null; renderMain(); } }, `Remove ${f.name}`),
          h('button', { class: 'ghost', onclick: () => { S.removeAsk = null; renderMain(); } }, 'Keep'))
        : h('button', { class: 'ghost', onclick: () => { S.removeAsk = f.id; renderMain(); } }, `Remove ${f.name}`))))
    : h('p', { class: 'muted' }, 'Nobody yet.');
  const input = h('input', { id: 'code', placeholder: 'XXXX-XXXX', autocapitalize: 'characters', autocomplete: 'off' });
  const forget = S.forgetAsk
    ? h('div', { class: 'card' }, h('p', { class: 'err' }, 'This erases your keys and everyone you linked from this phone. It cannot be undone.'),
      h('div', { class: 'row' },
        h('button', { class: 'no', onclick: async () => { try { await store.resetAll(); } catch { /* reload anyway */ } location.reload(); } }, 'Erase'),
        h('button', { class: 'ghost', onclick: () => { S.forgetAsk = false; renderMain(); } }, 'Keep')))
    : h('button', { class: 'ghost', onclick: () => { S.forgetAsk = true; renderMain(); } }, 'Erase everything on this phone');
  // The first thing here is always the same: the people, and the two ways to add one. Everything else is tucked underneath.
  return h('section', null, topbar('My people'), installCard(),
    h('h2', null, 'People I trust'), list,
    h('div', { class: 'row' },
      h('button', { onclick: showMyCode }, 'Add someone'),
      h('button', { class: 'ghost', onclick: openScanner }, 'Scan a code')),
    h('details', { class: 'more' }, h('summary', null, 'Type a code instead'),
      h('label', { for: 'code' }, 'The code from the other phone'), input,
      h('button', { onclick: async () => { const t = extractToken(input.value); if (t) await acceptToken(t); else toast('That code should be 8 letters or numbers.'); } }, 'Join')),
    h('h2', null, 'Connected apps'), appsCard(),
    h('details', { class: 'more' }, h('summary', null, 'More'),
      S.watch ? h('details', { class: 'more' }, h('summary', null, `Flagged senders${S.senders && S.senders.length ? ` (${S.senders.length})` : ''}`), sendersCard()) : null,
      h('details', { class: 'more' }, h('summary', null, 'Share a message from any app'), shareCard()),
      h('details', { class: 'more' }, h('summary', null, 'Notifications'), alertsCard()),
      h('details', { class: 'more' }, h('summary', null, 'Privacy'),
        h('p', null, 'Your private key stays on this phone. It cannot be copied out.'),
        h('p', null, 'Vouch does not save messages you check. If AI is on, the message is sent to Google\'s Gemini to be read.'),
        h('p', null, 'Only people you linked with can ever be asked.')),
      forget));
}

function extractToken(text) {
  const m = /pair=([A-Za-z0-9]+)/.exec(text);
  if (m) return m[1].toUpperCase();
  const t = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t.length === 8 ? t : null;
}

async function showMyCode() {
  try {
    const { token, expiresAt } = await call('pair:offer', {});
    S.codeView = token; S.codeExpires = expiresAt || Date.now() + 5 * 60 * 1000; S.codeExpired = false;
    renderOverlay();
  } catch (e) { toast(friendly(e)); }
}

async function acceptToken(token) {
  try {
    const { peer } = await call('pair:accept', { token });
    await onPeerPaired(peer);
  } catch (e) { toast(friendly(e)); }
}

async function onPeerPaired(peer) {
  const wordKey = await deriveWordKey(S.keys.exchKeyPair.privateKey, peer.exchPub);
  // Linking again with someone already on this phone replaces their old entry instead of adding a second one.
  for (const e of await store.listFriends()) {
    if (e.id === peer.id || e.signPub === peer.signPub || (e.name === peer.name && !isLinked(e))) await store.deleteFriend(e.id);
  }
  if (S.linked) S.linked.add(peer.id);
  await store.saveFriend({ id: peer.id, name: peer.name, signPub: peer.signPub, exchPub: peer.exchPub, wordKey, pairedAt: Date.now() });
  S.friends = await store.listFriends();
  S.codeView = null;
  S.queue.push({ kind: 'paired', peer, code: await safetyCode(S.pubs, peer) });
  renderMain();
}

// ---------- camera scanner ----------

function openScanner() {
  S.scanning = true;
  renderOverlay();
}

function stopStream() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
}

function closeScanner() {
  S.scanning = false;
  stopStream();
  renderOverlay();
}

function scanOverlay() {
  const video = h('video', { class: 'scanvideo', playsinline: true, autoplay: true });
  video.muted = true;
  video.setAttribute('webkit-playsinline', '');
  const msg = h('p', { role: 'status' }, 'Starting the camera…');
  const frame = h('div', { class: 'frame' }, h('i'), h('i'), h('i'), h('i'));
  const typed = h('input', { placeholder: 'Or type the code, like ABCD-2345', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Type the code instead' });
  const join = h('button', { onclick: async () => {
    const t = extractToken(typed.value);
    if (!t) { msg.textContent = 'That code should be 8 letters or numbers.'; return; }
    closeScanner();
    await acceptToken(t);
  } }, 'Join with this code');
  const cancel = h('button', { class: 'ghost', onclick: closeScanner }, 'Cancel');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastWarn = 0;

  const loop = async () => {
    if (!S.scanning || !S.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      // Scan the middle of the picture (where the frame is) at a reduced size so it stays quick.
      const side = Math.min(video.videoWidth, video.videoHeight);
      const size = Math.min(side, 640);
      canvas.width = size; canvas.height = size;
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      const r = globalThis.jsQR(img.data, size, size, { inversionAttempts: 'attemptBoth' });
      if (r && r.data) {
        const token = extractToken(r.data);
        if (token) { closeScanner(); await acceptToken(token); return; }
        if (Date.now() - lastWarn > 1500) { lastWarn = Date.now(); msg.textContent = "That QR code isn't a Vouch code. Try the one on your friend's screen."; }
      }
    }
    requestAnimationFrame(loop);
  };

  const fail = (err) => {
    const name = err && err.name;
    msg.textContent = name === 'NotAllowedError' || name === 'SecurityError'
      ? 'The camera is blocked. Allow it in your browser settings, or type the code below.'
      : (name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'No camera found. Type the code below.'
        : (name === 'NotReadableError' ? 'The camera is being used by another app. Close it, or type the code below.'
          : "Couldn't start the camera. Type the code below."));
  };

  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    msg.textContent = "This browser can't open the camera here. Type the code below.";
  } else {
    // Prefer the back camera; if the phone refuses that, take whatever camera it has.
    md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } })
      .catch((err) => (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') ? md.getUserMedia({ audio: false, video: true }) : Promise.reject(err)))
      .then((stream) => {
        if (!S.scanning) { stream.getTracks().forEach((t) => t.stop()); return null; }
        S.stream = stream;
        video.srcObject = stream;
        return video.play();
      })
      .then(() => { if (S.stream) { msg.textContent = 'Point the camera at the code'; loop(); } })
      .catch(fail);
  }

  return h('div', { class: 'overlay scan', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan a code' },
    video, frame, h('div', { class: 'scanbottom' }, msg, typed, join, cancel));
}

// ---------- overlays: scanner, pairing code, incoming prompts ----------

function renderOverlay() {
  if (!$overlay) return;
  const item = S.queue[0];
  let key = '';
  if (item) {
    key = `${item.kind}:${(item.data && item.data.requestId) || (item.data && item.data.u && item.data.u.requestId) || (item.peer && item.peer.id)}`;
  } else if (S.listening && !S.callMin) key = 'live';
  else if (S.scanning) key = 'scan';
  else if (S.codeView) key = `code:${S.codeView}:${S.codeExpired ? 'x' : 'ok'}`;
  if ($overlay.dataset.key === key) return; // already showing it; don't wipe what the person is typing
  if ($overlay.dataset.key === 'scan' && key !== 'scan') stopStream();
  $overlay.dataset.key = key;
  // While a dialog is up, the page behind it can't be reached by keyboard, screen reader or tap.
  for (const el of [$conn, $sticky, $banners, $toast, $content, document.getElementById('nav')]) if (el) el.inert = !!key;
  if (item) $overlay.replaceChildren(overlayFor(item));
  else if (key === 'live') $overlay.replaceChildren(liveCallOverlay());
  else if (S.scanning) $overlay.replaceChildren(scanOverlay());
  else if (S.codeView) $overlay.replaceChildren(codeOverlay(S.codeView));
  else $overlay.replaceChildren();
  // Move focus into the dialog so screen readers read it first.
  const first = key !== 'scan' && key !== 'live' && $overlay.querySelector('.inner > *');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
}

function dismiss() { S.queue.shift(); renderOverlay(); }

// Every full-screen message ends the same way: the buttons are pinned to the bottom of the screen, the main one first and big,
// the way out last and quiet, so nobody has to scroll or hunt to find where to tap. Details above can be as long as they like.
const actions = (...kids) => h('div', { class: 'actions' }, ...kids.filter(Boolean));
const quiet = (text, onclick) => h('button', { class: 'ghost quiet', onclick }, text);

function overlayFor(item) {
  if (item.kind === 'prompt') return promptOverlay(item.data);
  if (item.kind === 'confirm') return confirmOverlay(item.data);
  if (item.kind === 'alert') return alertOverlay(item.data);
  if (item.kind === 'scam') return scamOverlay(item.data);
  if (item.kind === 'call') return callOverlay(item.data);
  if (item.kind === 'callscam') return callScamOverlay(item.data);
  return pairedOverlay(item);
}

// Shown the instant a risky message is pasted or shared.
// "From @bob (Bob Smith). Vouch has flagged them 3 times." Who is behind a message, as far as the app it came through says.
function senderLine(s, repeat) {
  if (!s) return null;
  if (s.hidden) return "The sender hid who they are when forwarding, so Vouch can't track them.";
  const who = [s.handle, s.name && s.handle ? `(${s.name})` : s.name].filter(Boolean).join(' ') || 'an unknown sender';
  return `From ${who}.${s.count > 1 ? ` Vouch has flagged them ${s.count} times.` : ''}${repeat ? ' They were flagged for a scam before.' : ''}`;
}

// The warning body: what it is, who it claims to be, what stood out, what to do. From the AI when it has read the message,
// otherwise from the instant on-phone rules.
function scamBody(g, signals, impersonating, tags) {
  // What matters first: what it is, and what to do. The proof (who it claims to be, what stood out, links, pictures) is one tap away.
  const proof = [
    impersonating ? h('p', { class: 'claims' }, `It claims to be: ${impersonating}`) : null,
    signals && signals.length ? h('div', { class: 'flagbar' }, ...signals.map((s) => h('span', { class: 'chip' }, s))) : null,
    ...evidenceNodes(g),
  ].filter(Boolean);
  return [
    h('p', { class: 'big' }, g ? g.why : 'Do not send anything yet.'),
    g ? h('ol', { class: 'steps big' }, (g.steps || []).slice(0, 3).map((s) => h('li', null, s)))
      : (tags && tags.length ? h('ul', null, tags.map((t) => h('li', null, TAGS[t] || t))) : null),
    proof.length ? h('details', { class: 'whybox' }, h('summary', null, 'Why Vouch thinks so'), ...proof) : null,
  ];
}

function scamOverlay({ tags, institution, guide: given, source, sender, ai, aid, repeat, soft, signals, impersonating }) {
  const F = S.form;
  const guide = ai || given || classify(F.text);
  const friend = friendById(F.friendId) || (S.friends.length === 1 ? S.friends[0] : null);
  // An impostor "institution" isn't someone you can pair with, so the advice is to hang up and call a number you trust.
  // A message that arrived through a bot isn't in the form, so there we open the Check screen instead of sending it.
  // With several trusted people and none picked, we open the Check screen so the person picks, rather than asking the wrong one.
  const go = S.friends.length && !institution ? h('button', { onclick: async () => {
    dismiss();
    setTab('check');
    if (source || !friend) return;
    try { await submitCheck(); renderMain(); document.getElementById('result')?.scrollIntoView({ block: 'start' }); } catch (e) { toast(friendly(e)); }
  } }, !friend ? 'Check with a trusted person' : source ? `Check it with ${friend.name}'s phone` : `Ask ${friend.name}'s phone now`) : null;
  return h('div', { class: `overlay alert${soft ? ' soft' : ''}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'This message looks like a scam' },
    h('div', { class: 'inner' },
      source ? h('p', { class: 'muted', id: aid ? `s-${aid}` : undefined }, `Sent to Vouch from ${SOURCE_NAMES[source] || 'a message'}${ai ? ' · read by AI' : ''}`) : null,
      h('div', { class: 'stop', id: aid ? `t-${aid}` : undefined }, guide ? guide.title : 'This looks like a scam.'),
      sender ? h('p', { class: 'sender' }, senderLine(sender, repeat)) : null,
      h('div', { id: aid ? `g-${aid}` : undefined }, ...scamBody(guide, (ai && ai.signals) || signals, (ai && ai.impersonating) || impersonating, tags)),
      actions(go, quiet(go ? 'Close' : "OK, I won't send anything", dismiss))));
}
// Full-screen result of the live-call word check.
function callOverlay({ ok, name }) {
  const headline = ok ? `That's really ${name}.` : `NO MATCH. This is NOT ${name}.`;
  return h('div', { class: `overlay ${ok ? 'good' : 'alert'}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': headline },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, headline),
      ok ? h('p', { class: 'big' }, 'The shared word matched. Still never send gift cards.')
        : [h('p', { class: 'big' }, 'Hang up.'), h('p', null, `Call ${name} back on a number you already know.`)],
      actions(h('button', { onclick: dismiss }, 'OK'))));
}

function alertOverlay({ u, soft }) {
  const name = u.stages.information.claimedName;
  const conf = u.stages.confidence || {};
  const headline = soft ? 'Wait. Do not send yet.' : 'STOP. Do not send money.';
  const why = soft ? `${name} has not answered.`
    : (conf.answer === 'not_me' ? `${name} says this was NOT them. It is very likely a scam.` : 'Something does not add up.');
  const reasons = (u.reasons || []).length ? h('ul', null, u.reasons.map((r) => h('li', null, r))) : null;
  return h('div', { class: `overlay alert${soft ? ' soft' : ''}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': headline },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, headline), h('p', { class: 'big' }, why), reasons,
      h('p', null, 'Call them on a number you already know, or ask a family member.'),
      actions(soft ? h('button', { onclick: dismiss }, 'I understand') : pauseButton('I understand', PAUSE_SECONDS, dismiss))));
}

// Counts the pairing code down, and when it runs out offers a fresh one in a tap.
function tickCode() {
  if (!S.codeView || S.codeExpired) return;
  const left = Math.ceil((S.codeExpires - Date.now()) / 1000);
  if (left <= 0) { S.codeExpired = true; renderOverlay(); return; }
  const el = document.getElementById('codeleft');
  if (el) el.textContent = `Waiting for your friend. This code works once and expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
}

function codeOverlay(token) {
  if (S.codeExpired) {
    return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
      h('h2', null, 'That code expired'),
      h('p', null, 'Codes only last 5 minutes so nobody else can use one. Get a new one.'),
      actions(h('button', { onclick: showMyCode }, 'Get a new code'),
        quiet('Cancel', () => { S.codeView = null; S.codeExpired = false; renderOverlay(); }))));
  }
  const url = `${location.origin}/#pair=${token}`;
  const canvas = h('canvas', { class: 'qr', 'aria-label': 'QR code to link with me' });
  drawQr(canvas, url);
  const shown = `${token.slice(0, 4)}-${token.slice(4)}`;
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('h2', null, 'Add someone'),
    h('p', null, 'On their phone: open Vouch, tap My people, then Scan a code. Or use their camera app.'),
    h('div', { class: 'qrbox' }, canvas),
    h('p', { class: 'muted', style: 'text-align:center' }, 'Or type this code:'),
    h('div', { class: 'code' }, shown),
    h('p', { class: 'muted', id: 'codeleft', role: 'status' }, 'Waiting for your friend. This code works once and expires in 5:00.'),
    actions(quiet('Cancel', () => { S.codeView = null; renderOverlay(); }))));
}

function drawQr(canvas, text) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 10, margin = 4; // 4-module quiet zone, as the QR spec asks
  canvas.width = canvas.height = (n + margin * 2) * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
}

function pairedOverlay({ peer, code }) {
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('h2', null, `Linked with ${peer.name}`),
    h('p', null, 'Read this code out loud to each other. If it matches on both phones, you are safely linked.'),
    h('div', { class: 'code' }, code),
    actions(h('button', { onclick: () => { dismiss(); if ('Notification' in globalThis && Notification.permission === 'default') requestAlerts(); } }, 'It matches'),
      h('button', { class: 'no', onclick: async () => {
        // A different code means someone may have tampered with the link. Remove it here and start over in person.
        await store.deleteFriend(peer.id);
        S.friends = await store.listFriends();
        dismiss();
        renderMain();
        toast('Link removed. Link up again in person and compare the codes.');
      } }, "It doesn't match"))));
}

function promptOverlay(p) {
  const needRetype = p.tier >= 2;
  const retype = needRetype ? h('input', { inputmode: 'decimal', placeholder: 'Type the amount to confirm' }) : null;
  const msg = h('div');
  const send = async (answer, btns) => {
    let retypedCents;
    if (needRetype && answer === 'yes') {
      retypedCents = parseCents(retype.value);
      if (retypedCents !== p.amountCents) { msg.replaceChildren(h('p', { class: 'err' }, 'Type the exact amount to confirm.')); return; }
    } else if (needRetype) {
      retypedCents = p.amountCents; // "Not me" never makes anyone type anything; the server just wants the field at tier 2+
    }
    btns.forEach((b) => { b.disabled = true; });
    try {
      const fields = { requestId: p.requestId, checkerId: p.checker.id, claimedId: S.me.id, amountCents: p.amountCents, method: p.method, answer };
      const s = await signAnswer(S.keys.signKeyPair.privateKey, fields);
      await call('verify:answer', { requestId: p.requestId, answer, ...(retypedCents != null ? { retypedCents } : {}), ...s });
      dismiss();
    } catch (e) {
      msg.replaceChildren(h('p', { class: 'err' }, friendly(e)));
      if (['ALREADY_ANSWERED', 'NOT_FOUND', 'NOT_ALLOWED'].includes(e.message)) setTimeout(dismiss, 1500);
      btns.forEach((b) => { b.disabled = false; });
    }
  };
  const yes = h('button', { class: 'yes', onclick: () => send('yes', [yes, no]) }, 'Yes, that was me');
  const no = h('button', { class: 'no', onclick: () => send('not_me', [yes, no]) }, 'Not me');
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('p', { class: 'muted' }, 'Vouch check'),
    h('div', { class: 'big' }, `Did you just ask ${p.checker.name} for ${fmt(p.amountCents)} via ${label(METHODS, p.method)}?`),
    logos(METHOD_LOGOS[p.method], 'lg'),
    retype ? [h('label', null, 'Confirm the amount'), retype] : null, msg, actions(yes, no)));
}

function confirmOverlay(p) {
  const msg = h('div');
  const send = async (answer, btns) => {
    btns.forEach((b) => { b.disabled = true; });
    try {
      const fields = { requestId: p.requestId, confirmerId: S.me.id, claimedId: p.claimedId, amountCents: p.amountCents, answer };
      const s = await signConfirm(S.keys.signKeyPair.privateKey, fields);
      await call('verify:confirm', { requestId: p.requestId, answer, ...s });
      dismiss();
    } catch (e) {
      msg.replaceChildren(h('p', { class: 'err' }, friendly(e)));
      btns.forEach((b) => { b.disabled = false; });
    }
  };
  const yes = h('button', { class: 'yes', onclick: () => send('yes', [yes, no]) }, "Yes, that's real");
  const no = h('button', { class: 'no', onclick: () => send('no', [yes, no]) }, "No, that's not right");
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('p', { class: 'muted' }, 'Second opinion needed'),
    h('div', { class: 'big' }, `${p.checkerName} says ${p.claimedName} asked for ${fmt(p.amountCents)} via ${label(METHODS, p.method)}. Does that sound right?`),
    msg, actions(yes, no)));
}

// ---------- server events ----------

function wireEvents() {
  on('verify:update', (u) => { onUpdate(u); });
  // The AI finished reading a message after its warning was already shown: fill its view into that same warning.
  on('scam:ai', (m) => {
    if (!m || !m.id || !m.ai) return;
    const item = S.queue.find((q) => q.data && q.data.aid === m.id);
    if (item) { item.data.ai = m.ai; item.data.guide = { title: m.ai.title, why: m.ai.why, steps: m.ai.steps, links: m.ai.links, image: m.ai.image }; }
    const title = document.getElementById(`t-${m.id}`);
    if (title) title.textContent = m.ai.title;
    const src = document.getElementById(`s-${m.id}`);
    if (src && item) src.textContent = `Sent to Vouch from ${SOURCE_NAMES[item.data.source] || 'a message'} · read by AI`;
    const body = document.getElementById(`g-${m.id}`);
    if (body) body.replaceChildren(...scamBody({ title: m.ai.title, why: m.ai.why, steps: m.ai.steps, links: m.ai.links, image: m.ai.image }, m.ai.signals, m.ai.impersonating, []));
  });
  // A friend (or anyone paired) is asking this account to confirm that it sent a request.
  on('verify:prompt', (p) => {
    if (S.queue.some((q) => q.kind === 'prompt' && q.data.requestId === p.requestId)) return;
    S.queue.push({ kind: 'prompt', data: p });
    attention(`Did you just ask ${p.checker.name} for ${fmt(p.amountCents)}?`, [300, 150, 300]);
    notify('Vouch: please confirm', `Did you just ask ${p.checker.name} for ${fmt(p.amountCents)}?`, `req-${p.requestId}`);
    renderOverlay();
  });
  on('verify:confirm_prompt', (p) => {
    if (S.queue.some((q) => q.kind === 'confirm' && q.data.requestId === p.requestId)) return;
    S.queue.push({ kind: 'confirm', data: p });
    attention(`${p.checkerName} needs a second opinion about ${p.claimedName}.`, [300, 150, 300]);
    notify('Vouch: second opinion needed', `${p.checkerName} needs you to confirm a request from ${p.claimedName}.`, `conf-${p.requestId}`);
    renderOverlay();
  });
  on('pair:completed', (msg) => { if (msg && msg.peer) onPeerPaired(msg.peer); });
  // The bot just linked a chat to this account (the person tapped Start / Send in the other app).
  on('watch:linked', async (m) => {
    S.linkCode = null;
    await loadWatch();
    toast(`${SOURCE_APP[m && m.channel] || 'That app'} is connected. Forward it a suspicious message to try it.`, 'ok');
    if (S.tab === 'friends') renderMain();
  });
  // A message bot (Telegram, text, WhatsApp) flagged something sent to a chat linked to this account.
  on('scam:alert', (a) => {
    if (!a) return;
    const id = `bot-${a.ts || Date.now()}`;
    const guide = a.ai ? { title: a.ai.title, why: a.ai.why, steps: a.ai.steps, links: a.ai.links, image: a.ai.image } : { title: a.title, why: a.why, steps: a.steps || [] };
    S.queue.push({ kind: 'scam', data: { requestId: id, tags: a.tags || [], institution: false, guide, source: a.source, sender: a.sender, ai: a.ai, aid: a.id, repeat: a.repeat, soft: a.level !== 2, signals: a.signals, impersonating: a.impersonating } });
    if (a.sender && !a.sender.hidden) loadSenders().then(() => { if (S.tab === 'friends') renderMain(); });
    raiseAlert(a.level === 2 ? 2 : 1, `${a.title}. Sent to Vouch from ${SOURCE_NAMES[a.source] || 'a message'}.`, id);
    attention(a.level === 2 ? `Warning. ${a.title}. Do not send anything.` : `${a.title}. Make sure it is really them.`, a.level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]);
    notify(a.level === 2 ? 'Vouch: this message looks like a scam' : 'Vouch: this message asks for money', a.title, `bot-${a.source}`);
    renderOverlay();
  });
  on('circle:alert', (a) => {
    const box = h('div', { class: 'banner' }, `Warning: someone may be pretending to be ${a.impersonatedName}. Don't send money.`);
    box.append(h('button', { onclick: () => box.remove() }, 'Dismiss'));
    $banners.append(box);
    attention(`Warning. Someone may be pretending to be ${a.impersonatedName}.`, [300, 150, 300]);
    notify('Vouch: warning', `Someone may be pretending to be ${a.impersonatedName}. Don't send money.`, `alert-${a.requestId}`);
  });
  on('demo:reset', async (d) => {
    if (d && d.hard) { try { await store.resetAll(); } catch { /* reload anyway */ } location.reload(); return; }
    S.results.clear(); S.texts.clear(); S.current = null; S.queue.length = 0;
    renderMain();
  });
}

boot();
