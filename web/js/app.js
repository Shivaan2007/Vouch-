// Vouch phone app (PROTOCOL v2). Plain ES modules, no build step.
// Every dynamic string goes through textContent (h() below), never innerHTML.

import {
  createIdentityKeys, exportPub, signString, deriveWordKey, currentWord, checkWord,
  safetyCode, verifyAnswer, signAnswer, signConfirm,
} from './lib/crypto.js';
import { authString } from './lib/canonical.js';
import * as store from './lib/store.js';
import { connect, call, on } from './lib/api.js';
import { TAG_LABELS as TAGS, suggest, riskyEnough, callRisk } from './lib/scan.js';

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
  NEED_AMOUNT: 'Please type how much they asked for, like 60 or 60.50.', NEED_FRIEND: 'Link up with someone you trust first.',
};
const friendly = (e) => ERRORS[e && e.message] || `Something went wrong (${e && e.message})`;

// Big radio cards (native inputs, so screen readers and keyboards work).
let choiceSeq = 0;
function choice(legend, options, selected, onchange, cls) {
  const name = `c${++choiceSeq}`;
  return h('fieldset', null, h('legend', null, legend),
    h('div', { class: `choices ${cls || ''}` }, options.map(([value, text]) =>
      h('label', { class: 'choice' },
        h('input', { type: 'radio', name, value, checked: value === selected, onchange: () => onchange(value) }),
        h('span', null, text)))));
}

// Get a person's attention without relying on sight alone: vibrate (Android) and speak aloud.
function attention(text, pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ }
  try {
    if ('speechSynthesis' in globalThis) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      speechSynthesis.speak(u);
    }
  } catch { /* not supported */ }
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
  friends: [], tab: 'check', pendingPair: null, current: null, results: new Map(), texts: new Map(),
  drafts: {}, queue: [], codeView: null, scanning: false, stream: null, wordFriendId: null,
  announced: new Map(), size: 1, forgetAsk: false, bootError: '',
  form: { friendId: '', method: 'venmo_cashapp_zelle', channel: 'text', amount: '', text: '', amountTouched: false, methodTouched: false },
};
const $app = document.getElementById('app');
let $content, $status, $banners, $overlay, $toast, $conn;
let toastTimer = null;
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
// Scams work by rushing people. While something risky is unresolved Vouch keeps a red banner on screen, repeats the
// warning aloud and as a notification, and makes you wait before you can wave it away.

const PAUSE_SECONDS = 10; // the same cooling-off pause the server config documents
const REPEAT_MS = 25000;
const MAX_REPEATS = 8;
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
  const f = friendById(S.wordFriendId) || S.friends[0];
  $sticky.replaceChildren(h('div', { class: `banner${A.level === 2 ? '' : ' soft'}`, role: 'alert' },
    h('div', { class: 'bannerhead' }, A.level === 2 ? 'DO NOT SEND ANYTHING' : 'WAIT. CHECK FIRST.'),
    h('p', null, A.reason),
    f ? h('button', { onclick: () => { S.wordFriendId = f.id; revealWord(); setTab('word'); } }, 'Get our code word') : null,
    f ? h('button', { onclick: () => { if (A.source === 'call') askAboutCall(); else setTab('check'); } }, `Check with ${f.name}'s phone`) : null,
    pauseButton('I checked it. Clear this', PAUSE_SECONDS, clearAlert, 'ghost'),
    h('button', { class: 'ghost', onclick: () => { A.mutedUntil = Date.now() + 120000; toast('Quiet for 2 minutes. The banner stays.', 'ok'); } }, 'Quiet for 2 minutes')));
}

function repeatAlert() {
  if (!A.active || Date.now() < A.mutedUntil || A.repeats >= MAX_REPEATS) return;
  A.repeats += 1;
  const line = A.level === 2 ? 'Still no confirmation. Do not send money.' : 'Reminder. Make sure it is really them before you send anything.';
  attention(line, A.level === 2 ? [400, 150, 400] : [250, 120, 250]);
  notify(A.level === 2 ? 'Vouch: do NOT send money' : 'Vouch: check first', A.reason, 'repeat');
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
    history.replaceState(null, '', location.pathname + location.hash);
  }
  S.size = loadSize();
  applySize(S.size);
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch { /* optional */ }
  buildShell();
  if (!store.isPersistent() || S.bootError) {
    const why = S.bootError || store.storageProblem();
    $banners.append(h('div', { class: 'card' },
      h('p', null, "This browser won't let Vouch save your key, so it can only remember you while this tab stays open. Don't reload or close it during the demo."),
      h('p', { class: 'muted' }, `Details: ${why}`)));
  }
  renderMain();
  wireEvents();
  connect({ onChallenge, onStatus });
  setInterval(tickWord, 1000);
  setInterval(repeatAlert, REPEAT_MS);
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
  await syncFriends();
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
  $banners = h('div', { role: 'alert' });
  $toast = h('div', { role: 'status', 'aria-live': 'polite' });
  $content = h('main');
  $overlay = h('div');
  const tabs = [['check', 'Check a message'], ['word', 'On a call'], ['friends', 'My people']];
  const nav = h('nav', { id: 'nav', 'aria-label': 'Main' }, tabs.map(([key, text]) =>
    h('button', { 'data-tab': key, onclick: () => setTab(key) }, text)));
  const size = h('button', { class: 'ghost size', 'aria-label': 'Change text size', onclick: () => {
    S.size = (S.size % 3) + 1;
    applySize(S.size);
    saveSize(S.size);
  } }, 'A+');
  $app.replaceChildren(h('header', null, h('h1', null, 'Vouch'), h('div', { class: 'hgroup' }, $status, size)), $conn, $sticky, $banners, $toast, $content, nav, $overlay);
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
}

function renderMain() {
  const nav = document.getElementById('nav');
  if (nav) {
    nav.hidden = !S.me;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  }
  if (!S.me) return $content.replaceChildren(setupView());
  if (S.tab === 'check') { $content.replaceChildren(checkView()); renderResult(); }
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
    S.pendingPair ? h('p', { class: 'ok' }, "You'll be linked to your friend right after this.") : null,
    h('label', { for: 'name' }, 'Your name'), name, btn, msg);
}

// ---------- check a message ----------

// The moment a risky message lands (pasted or shared), warn right away, aloud, before anyone has to ask.
// This is an on-phone warning only; it never clears anything.
function flashIfRisky() {
  if (!S.me) return;
  const text = S.form.text;
  const { tags } = suggest(text);
  if (!text || !riskyEnough(tags) || S.flashedFor === text) return;
  S.flashedFor = text;
  S.queue.push({ kind: 'scam', data: { requestId: `local-${Date.now()}`, tags } });
  raiseAlert(2, 'This message has scam warning signs. Check it before you send anything.', 'message');
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
  const { requestId } = await call('verify:request', body);
  if (sent) S.texts.set(requestId, sent); // kept in this tab's memory only
  S.current = requestId;
  Object.assign(F, { text: '', amount: '', amountTouched: false, methodTouched: false });
  return requestId;
}

function checkView() {
  if (!S.friends.length) {
    return h('section', null, h('h2', null, 'Check a message'),
      h('p', null, 'First, link up with someone you trust. Then Vouch can ask their phone.'),
      h('button', { onclick: () => setTab('friends') }, 'Add someone'));
  }
  const F = S.form;
  if (!F.friendId || !friendById(F.friendId)) F.friendId = S.friends[0].id;

  const flags = h('div', { class: 'flagbar', 'aria-live': 'polite' });
  const paintFlags = () => {
    const s = suggest(F.text);
    if (s.tags.length) flags.replaceChildren(h('span', null, 'Looks risky:'), ...s.tags.map((t) => h('span', { class: 'chip' }, TAGS[t])));
    else if (s.ask) flags.replaceChildren(h('span', null, 'This asks for money. Check who it is before you send anything.'));
    else flags.replaceChildren();
  };
  const text = h('textarea', { id: 'text', maxlength: '2000', placeholder: 'Paste the message you received', oninput: () => onText() });
  const amount = h('input', { id: 'amount', inputmode: 'decimal', placeholder: 'For example 60', oninput: () => { F.amount = amount.value; F.amountTouched = true; } });
  const method = h('select', { id: 'method', onchange: () => { F.method = method.value; F.methodTouched = true; } },
    METHODS.map(([k, t]) => h('option', { value: k }, t)));
  text.value = F.text; amount.value = F.amount; method.value = F.method;
  function onText() {
    F.text = text.value;
    const s = suggest(F.text);
    if (s.amount && !F.amountTouched) { F.amount = s.amount; amount.value = s.amount; }
    if (s.method && !F.methodTouched) { F.method = s.method; method.value = s.method; }
    paintFlags();
  }
  paintFlags();

  const who = S.friends.length > 1
    ? choice('Who does it say it is?', S.friends.map((f) => [f.id, f.name]), F.friendId, (v) => { F.friendId = v; })
    : h('p', { class: 'big' }, `It says it's ${S.friends[0].name}.`);
  const channel = choice('How did they reach you?', CHANNELS, F.channel, (v) => { F.channel = v; }, 'two');
  const msg = h('div', { role: 'alert' });
  const paste = h('button', { class: 'ghost', onclick: async () => {
    try {
      const clip = (await navigator.clipboard.readText()).slice(0, 2000);
      if (!clip.trim()) { msg.replaceChildren(h('p', { class: 'err' }, 'Nothing copied yet. Copy the message first, then tap Paste.')); return; }
      text.value = clip; onText(); msg.replaceChildren(); flashIfRisky();
    } catch { msg.replaceChildren(h('p', { class: 'err' }, 'Your phone blocked that. Press and hold in the box, then tap Paste.')); }
  } }, 'Paste the message');
  const example = h('button', { class: 'ghost', onclick: () => {
    Object.assign(F, { channel: 'text', amountTouched: false, methodTouched: false, amount: '', method: 'venmo_cashapp_zelle',
      text: "hey it's me, new number! I'm stuck at the store and my card got declined. Can you buy $200 in Apple gift cards right now? Please don't tell mom, I'll pay you back tonight." });
    onTextAfterExample();
  } }, 'Try an example scam');
  function onTextAfterExample() {
    const s = suggest(F.text);
    F.amount = s.amount; if (s.method) F.method = s.method;
    renderMain();
    flashIfRisky();
  }
  const btn = h('button', { onclick: async () => {
    btn.disabled = true;
    msg.replaceChildren();
    try {
      await submitCheck();
      renderMain();
      document.getElementById('result')?.scrollIntoView({ block: 'start' });
    } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    btn.disabled = false;
  } }, 'Check now');

  return h('section', null, h('h2', null, 'Is this request real?'),
    h('p', { class: 'muted' }, "We'll ask their real phone. Your message is checked and not saved."),
    h('label', { for: 'text' }, '1. The message'), text, flags, h('div', { class: 'row' }, paste, example),
    h('div', null, who), h('div', null, channel),
    h('label', { for: 'amount' }, '2. How much do they want? ($)'), amount,
    h('label', { for: 'method' }, '3. How do they want it?'), method,
    btn, msg,
    h('div', { id: 'result', 'aria-live': 'polite' }));
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
    attention(line, [400, 150, 400, 150, 400]);
    notify('Vouch: do not send money', conf.answer === 'not_me' ? `${name} says this was not them.` : 'Something does not add up.', `res-${u.requestId}`);
  } else if (u.verdict === 'amber' && conf.answer === 'timeout') {
    S.queue.push({ kind: 'alert', data: { u, soft: true } });
    raiseAlert(1, `${name} has not answered. Do not send yet.`, `req-${u.requestId}`);
    attention(`Wait. ${name} has not answered. Do not send money yet.`, [300, 150, 300]);
    notify('Vouch: wait', `${name} has not answered yet.`, `res-${u.requestId}`);
  } else if (u.verdict === 'amber') {
    raiseAlert(1, (u.reasons && u.reasons[0]) || 'Wait for confirmation before you send anything.', `req-${u.requestId}`);
  } else if (u.verdict === 'green') {
    clearAlert();
    attention(`Verified. ${name} confirmed this on their own phone.`, 80);
    notify('Vouch: verified', `${name} confirmed this on their own phone.`, `res-${u.requestId}`);
  }
  renderOverlay();
}

function renderResult() {
  const box = document.getElementById('result');
  if (!box) return;
  const u = S.results.get(S.current);
  if (!u) { box.replaceChildren(h('p', { class: 'muted' }, 'Asking their phone…')); return; }
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
      h('p', null, `${name} · ${fmt(info.amountCents)} · ${label(METHODS, info.method)} · ${label(CHANNELS, info.channel)}`)),
    h('div', { class: 'stage' }, h('b', null, '2 · AI check'),
      und.explanation ? h('p', null, und.explanation) : null,
      tags.length ? tags.map((t) => h('span', { class: 'chip' }, TAGS[t] || t)) : h('p', null, 'Nothing stands out.'),
      und.paymentRisk ? h('p', null, `Payment risk: ${und.paymentRisk}`) : null,
      und.firstRequest ? h('p', null, `This is the first time ${name} has asked you for money.`) : null,
      h('p', { class: 'muted' }, `AI can warn. Only ${name}'s own phone can clear a request.`)),
    h('div', { class: 'stage' }, h('b', null, '3 · Did they confirm?'),
      h('p', null, answerText),
      u.needs && u.needs.word ? h('p', null, conf.wordOk ? 'Shared word matched.' : 'Shared word still needed.') : null,
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

// The code word is generated on demand, like an authenticator app: tap to see it, it expires with the minute.
function revealWord() {
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

// They're asking for money on the call: open the check, already set up for a call.
function askAboutCall() {
  S.form.channel = 'call';
  const amt = callRisk(`${S.heard || ''} ${S.cur || ''}`).amount;
  if (amt && !S.form.amountTouched) S.form.amount = amt;
  setTab('check');
}

function paintWordArea() {
  const box = document.getElementById('wordarea');
  const f = friendById(S.wordFriendId);
  if (!box || !f) return;
  if (!S.wordShown) {
    box.replaceChildren(
      h('p', { class: S.wordExpired ? 'err' : 'muted' }, S.wordExpired ? 'That word expired. Get a new one.' : `Tap to see the code word you and ${f.name} share right now.`),
      h('button', { onclick: revealWord }, 'Get our code word'));
    return;
  }
  const said = h('input', { id: 'said', placeholder: 'The two words they said', autocapitalize: 'none', autocomplete: 'off' });
  const typedMsg = h('div', { role: 'alert' });
  box.replaceChildren(
    h('div', { class: 'bigword', id: 'bigword' }, '…'),
    h('div', { class: 'meter', 'aria-hidden': 'true' }, h('div', { class: 'meterfill', id: 'wordbar' })),
    h('p', { class: 'muted', id: 'wordleft', style: 'text-align:center' }),
    h('p', null, 'Ask them: "What\'s our word?" Let them say it first. Never read it out first.'),
    h('div', { class: 'row' },
      h('button', { class: 'yes', onclick: () => callResult(true) }, 'It matches'),
      h('button', { class: 'no', onclick: () => callResult(false) }, "It doesn't match")),
    h('details', null, h('summary', null, 'Type what they said instead'),
      h('label', { for: 'said' }, 'The two words'), said,
      h('button', { class: 'ghost', onclick: async () => {
        if (!said.value.trim()) { typedMsg.replaceChildren(h('p', { class: 'err' }, 'Type the two words they said.')); return; }
        callResult(await checkWord(f.wordKey, said.value));
      } }, 'Check it'), typedMsg),
    h('button', { class: 'ghost', onclick: () => { S.wordShown = false; paintWordArea(); } }, 'Hide the word'));
}

function wordView() {
  if (!S.friends.length) {
    return h('section', null, h('h2', null, 'On a call'), h('p', null, 'Link up with someone first to get a word only you two know.'),
      h('button', { onclick: () => setTab('friends') }, 'Add someone'));
  }
  if (!S.wordFriendId || !friendById(S.wordFriendId)) S.wordFriendId = S.friends[0].id;
  const who = S.friends.length > 1
    ? choice('Who is calling?', S.friends.map((f) => [f.id, f.name]), S.wordFriendId, (v) => { S.wordFriendId = v; S.wordShown = false; S.wordExpired = false; paintWordArea(); })
    : null;
  queueMicrotask(() => { paintWordArea(); tickWord(); });
  return h('section', null, h('h2', null, 'On a call'),
    h('p', null, 'Not sure who is really calling? Get your code word and ask them for it.'),
    who, h('div', { id: 'wordarea' }),
    listenCard(),
    h('button', { class: 'ghost', onclick: askAboutCall }, "They're asking me for money"));
}

async function tickWord() {
  if (S.tab !== 'word' || !S.wordShown) return;
  const f = friendById(S.wordFriendId);
  if (!f) return;
  const { word, minute, secondsLeft } = await currentWord(f.wordKey);
  if (minute !== S.wordMinute) { S.wordShown = false; S.wordExpired = true; paintWordArea(); return; }
  const big = document.getElementById('bigword');
  if (!big) return;
  big.textContent = word;
  const left = document.getElementById('wordleft');
  if (left) left.textContent = `expires in ${secondsLeft}s`;
  const bar = document.getElementById('wordbar');
  if (bar) bar.style.width = `${(secondsLeft / 60) * 100}%`;
}

// ---------- watch a call ----------
// Uses the browser's own speech recognition on the speakerphone. The words are checked on this phone, then dropped:
// nothing is recorded, saved or sent by Vouch. (The browser's speech service may process the audio to make text.)

function listenCard() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (S.listening) {
    return h('div', { class: 'card' }, h('b', null, 'Watching this call'),
      h('p', { class: 'muted', id: 'transcript' }, (S.cur || S.heard || '').slice(-200) || 'Listening…'),
      h('button', { class: 'ghost', onclick: stopListening }, 'Stop watching'));
  }
  return h('div', { class: 'card' }, h('b', null, 'Watch this call for scams'),
    h('p', null, 'Put the call on speaker, then start. Vouch warns you the moment someone asks for money. Vouch does not record or save the call.'),
    h('p', { class: 'muted' }, "Your browser's speech service may process the audio. Tell the other person you're using it."),
    SR ? h('button', { onclick: startListening }, 'Start watching')
      : h('p', { class: 'muted' }, "This browser can't listen. Use Check a message instead."),
    h('p', { class: 'muted' }, 'Some phones block the microphone during a call. If yours does, put Vouch on a second phone or tablet next to the call.'));
}

function startListening() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SR) return;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  S.listening = true; S.heard = ''; S.cur = ''; S.callLevel = 0; S.rec = rec;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += `${e.results[i][0].transcript} `;
    S.cur = text.slice(-1500);
    const t = document.getElementById('transcript');
    if (t) t.textContent = S.cur.slice(-200);
    scanCall();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopListening(); toast('The microphone is blocked. Allow it in your browser settings.'); }
    else if (e.error === 'audio-capture') { stopListening(); toast("Couldn't use the microphone. Some phones block it during a call; use a second phone next to the call."); }
  };
  rec.onend = () => { // browsers end a session after a pause; start again while the person is still watching
    if (!S.listening) return;
    S.heard = `${S.heard} ${S.cur}`.slice(-1500); S.cur = '';
    try { rec.start(); } catch { /* already starting */ }
  };
  try { rec.start(); } catch (e) { S.listening = false; toast("Couldn't start listening."); }
  paintStatus();
  renderMain();
}

function stopListening() {
  S.listening = false;
  try { if (S.rec) S.rec.stop(); } catch { /* already stopped */ }
  S.rec = null; S.heard = ''; S.cur = '';
  if (A.source === 'call') clearAlert();
  paintStatus();
  renderMain();
}

// 0 = nothing; 1 = someone is asking for money (check who it is); 2 = asking for money with scam warning signs.
function scanCall() {
  const r = callRisk(`${S.heard || ''} ${S.cur || ''}`);
  if (r.level <= (S.callLevel || 0)) return;
  S.callLevel = r.level;
  S.queue.push({ kind: 'callscam', data: { requestId: `callscam-${r.level}-${Date.now()}`, level: r.level, tags: r.tags } });
  raiseAlert(r.level, r.level === 2 ? 'This call has scam warning signs.' : 'Someone on this call is asking for money.', 'call');
  attention(r.level === 2 ? 'Stop. This call has scam warning signs. Do not send anything.' : 'Someone on this call is asking for money. Make sure it is really them.',
    r.level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]);
  notify(r.level === 2 ? 'Vouch: this call looks like a scam' : 'Vouch: this call asks for money', 'Open Vouch and ask for your code word.', 'callscam');
  renderOverlay();
}

function callScamOverlay({ level, tags }) {
  const f = friendById(S.wordFriendId) || S.friends[0];
  const hard = level === 2;
  return h('div', { class: `overlay alert${hard ? '' : ' soft'}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Scam warning' },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, hard ? 'STOP. This call looks like a scam.' : 'Someone is asking for money.'),
      h('p', { class: 'big' }, hard ? 'Do not send anything.' : 'Make sure it is really them before you do anything.'),
      tags.length ? h('ul', null, tags.map((t) => h('li', null, TAGS[t] || t))) : null,
      f ? h('button', { onclick: () => { dismiss(); S.wordFriendId = f.id; revealWord(); setTab('word'); } }, 'Get our code word') : null,
      f ? h('button', { class: 'ghost', onclick: () => { dismiss(); askAboutCall(); } }, `Check with ${f.name}'s phone`) : null,
      h('button', { class: 'ghost', onclick: dismiss }, 'Keep listening')));
}

// ---------- my people + pairing ----------

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
  return h('section', null, h('h2', null, `Hello, ${S.me.name}`),
    h('h2', null, 'People I trust'), list,
    h('button', { onclick: showMyCode }, 'Add someone: show my code'),
    h('label', { for: 'code' }, 'Have a code from someone?'), input,
    h('div', { class: 'row' },
      h('button', { onclick: async () => { const t = extractToken(input.value); if (t) await acceptToken(t); else toast('That code should be 8 letters or numbers.'); } }, 'Join'),
      h('button', { class: 'ghost', onclick: openScanner }, 'Scan a code')),
    h('h2', null, 'Send messages to Vouch'), h('div', { class: 'card' }, shareCard()),
    h('h2', null, 'Alerts'), h('div', { class: 'card' }, alertsCard()),
    h('h2', null, 'Your privacy'),
    h('div', { class: 'card' },
      h('p', null, 'Your private key stays on this phone. It cannot be copied out.'),
      h('p', null, 'Messages you check are never saved. Only the answer is.'),
      h('p', null, 'Only people you linked with can ever be asked.')),
    forget);
}

function extractToken(text) {
  const m = /pair=([A-Za-z0-9]+)/.exec(text);
  if (m) return m[1].toUpperCase();
  const t = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t.length === 8 ? t : null;
}

async function showMyCode() {
  try {
    const { token } = await call('pair:offer', {});
    S.codeView = token;
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
  const typeIt = h('button', { onclick: closeScanner }, 'Cancel');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

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
      const token = r && r.data && extractToken(r.data);
      if (token) { closeScanner(); await acceptToken(token); return; }
    }
    requestAnimationFrame(loop);
  };

  navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } })
    .then((stream) => {
      if (!S.scanning) { stream.getTracks().forEach((t) => t.stop()); return null; }
      S.stream = stream;
      video.srcObject = stream;
      return video.play();
    })
    .then(() => { if (S.stream) { msg.textContent = 'Point the camera at the code'; loop(); } })
    .catch((err) => {
      msg.textContent = err && err.name === 'NotAllowedError'
        ? 'The camera is blocked. Allow it in your browser settings, or close this and type the code.'
        : "Couldn't start the camera. Close this and type the code instead.";
      typeIt.textContent = 'Close';
    });

  return h('div', { class: 'overlay scan', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan a code' },
    video, frame, h('div', { class: 'scanbottom' }, msg, typeIt));
}

// ---------- overlays: scanner, pairing code, incoming prompts ----------

function renderOverlay() {
  if (!$overlay) return;
  const item = S.queue[0];
  let key = '';
  if (item) {
    key = `${item.kind}:${(item.data && item.data.requestId) || (item.data && item.data.u && item.data.u.requestId) || (item.peer && item.peer.id)}`;
  } else if (S.scanning) key = 'scan';
  else if (S.codeView) key = `code:${S.codeView}`;
  if ($overlay.dataset.key === key) return; // already showing it; don't wipe what the person is typing
  if ($overlay.dataset.key === 'scan' && key !== 'scan') stopStream();
  $overlay.dataset.key = key;
  if (item) $overlay.replaceChildren(overlayFor(item));
  else if (S.scanning) $overlay.replaceChildren(scanOverlay());
  else if (S.codeView) $overlay.replaceChildren(codeOverlay(S.codeView));
  else $overlay.replaceChildren();
  // Move focus into the dialog so screen readers read it first.
  const first = key !== 'scan' && $overlay.querySelector('.inner > *');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
}

function dismiss() { S.queue.shift(); renderOverlay(); }

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
function scamOverlay({ tags }) {
  const F = S.form;
  const friend = friendById(F.friendId) || S.friends[0];
  const go = friend ? h('button', { onclick: async () => {
    dismiss();
    setTab('check');
    try { await submitCheck(); renderMain(); document.getElementById('result')?.scrollIntoView({ block: 'start' }); } catch (e) { toast(friendly(e)); }
  } }, `Ask ${friend.name}'s phone now`) : null;
  return h('div', { class: 'overlay alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'This message looks like a scam' },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, 'This looks like a scam.'),
      h('p', { class: 'big' }, 'Do not send anything yet.'),
      h('ul', null, tags.map((t) => h('li', null, TAGS[t] || t))),
      h('p', null, 'Check it with someone you trust. It takes a few seconds.'),
      go, h('button', { class: 'ghost', onclick: dismiss }, 'Not now')));
}

// Full-screen result of the live-call word check.
function callOverlay({ ok, name }) {
  const headline = ok ? `That's really ${name}.` : `NO MATCH. This is NOT ${name}.`;
  return h('div', { class: `overlay ${ok ? 'good' : 'alert'}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': headline },
    h('div', { class: 'inner' },
      h('div', { class: 'stop' }, headline),
      ok ? h('p', { class: 'big' }, 'The shared word matched. Still never send gift cards.')
        : [h('p', { class: 'big' }, 'Hang up.'), h('p', null, `Call ${name} back on a number you already know.`)],
      h('button', { onclick: dismiss }, 'OK')));
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
      soft ? h('button', { onclick: dismiss }, 'I understand') : pauseButton('I understand', PAUSE_SECONDS, dismiss)));
}

function codeOverlay(token) {
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
    h('p', { class: 'muted' }, 'Waiting for your friend. The code works once and expires in 5 minutes.'),
    h('button', { class: 'ghost', onclick: () => { S.codeView = null; renderOverlay(); } }, 'Cancel')));
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
    h('button', { onclick: () => { dismiss(); if ('Notification' in globalThis && Notification.permission === 'default') requestAlerts(); } }, 'It matches')));
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
    retype ? [h('label', null, 'Confirm the amount'), retype] : null, yes, no, msg));
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
    yes, no, msg));
}

// ---------- server events ----------

function wireEvents() {
  on('verify:update', (u) => { onUpdate(u); });
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
