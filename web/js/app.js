// Vouch phone app (PROTOCOL v2). Plain ES modules, no build step.
// Every dynamic string goes through textContent (h() below), never innerHTML.

import {
  createIdentityKeys, exportPub, signString, deriveWordKey, currentWord, checkWord,
  safetyCode, verifyAnswer, signAnswer, signConfirm,
} from './lib/crypto.js';
import { authString } from './lib/canonical.js';
import * as store from './lib/store.js';
import { connect, call, on } from './lib/api.js';

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
const CHANNELS = [['text', 'Text message'], ['call', 'Phone call'], ['dm', 'Direct message'], ['email', 'Email']];
const label = (list, key) => (list.find(([k]) => k === key) || [key, key])[1];
const TAGS = {
  URGENCY: 'Pressure to act fast', SECRECY: 'Asks you to keep it secret', NEW_NUMBER: 'New number',
  GIFT_CARD: 'Gift cards', WIRE: 'Wire transfer', CRYPTO: 'Crypto', PAYBACK_PROMISE: 'Promises to pay back',
  FIRST_REQUEST: "First time they've asked",
};
const ERRORS = {
  OFFLINE: "You're offline. Reconnecting…", TIMEOUT: 'The server took too long. Try again.',
  TOKEN_INVALID: 'That code is invalid or expired.', ALREADY_PAIRED: "You're already paired.",
  SELF_PAIR: "That's your own code.", NOT_PAIRED: "You aren't paired with them.",
  AMOUNT_MISMATCH: "The amount you typed doesn't match.", BAD_SIGNATURE: "Your signature wasn't accepted.",
  ALREADY_ANSWERED: 'This was already answered.', NOT_FOUND: 'This request is gone.',
  RATE_LIMITED: 'Slow down a little.', BAD_INPUT: 'Check what you entered.',
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
  friends: [], tab: 'check', pendingPair: null, current: null, results: new Map(),
  drafts: {}, queue: [], codeView: null, wordFriendId: null, announced: new Map(), size: 1, forgetAsk: false,
  form: { friendId: '', method: 'venmo_cashapp_zelle', channel: 'text', amount: '', text: '' },
};
const $app = document.getElementById('app');
let $content, $status, $banners, $overlay, $toast;
let toastTimer = null;
const friendById = (id) => S.friends.find((f) => f.id === id);

function toast(msg, kind) {
  if (!$toast) return;
  $toast.replaceChildren(h('p', { class: kind === 'ok' ? 'ok' : 'err' }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.replaceChildren(), 5000);
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
    $app.append(h('p', { class: 'err' }, "This browser is blocking storage, so Vouch can't keep your keys. Turn off private browsing and reload."));
    return;
  }
  const m = /pair=([A-Za-z0-9]+)/.exec(location.hash);
  if (m) S.pendingPair = m[1].toUpperCase();
  // Android "Share to Vouch": the shared message arrives as ?text=...
  const q = new URLSearchParams(location.search);
  const shared = q.get('text') || q.get('title') || q.get('url');
  if (shared) { S.form.text = shared.slice(0, 2000); history.replaceState(null, '', location.pathname + location.hash); }
  S.size = loadSize();
  applySize(S.size);
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js'); } catch { /* optional */ }
  buildShell();
  renderMain();
  wireEvents();
  connect({ onChallenge, onStatus });
  setInterval(tickWord, 1000);
}

async function pubsOf(keys) {
  return { signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
}

function onStatus(online) {
  S.online = online;
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
}

async function syncFriends() {
  try {
    const { friends } = await call('circle:list');
    const local = await store.listFriends();
    for (const l of local) if (!friends.some((f) => f.id === l.id)) await store.deleteFriend(l.id);
    for (const f of friends) {
      if (!local.some((l) => l.id === f.id)) {
        const wordKey = await deriveWordKey(S.keys.exchKeyPair.privateKey, f.exchPub);
        await store.saveFriend({ ...f, wordKey });
      }
    }
    S.friends = await store.listFriends();
  } catch (e) { toast(friendly(e)); }
}

// ---------- shell ----------

function buildShell() {
  $status = h('span', { class: 'pill off', role: 'status' }, 'offline');
  $banners = h('div', { role: 'alert' });
  $toast = h('div', { role: 'status', 'aria-live': 'polite' });
  $content = h('main');
  $overlay = h('div');
  const tabs = [['check', '✉️ Check a message'], ['word', '☎️ On a call?'], ['friends', '👪 My people']];
  const nav = h('nav', { id: 'nav', 'aria-label': 'Main' }, tabs.map(([key, text]) =>
    h('button', { 'data-tab': key, onclick: () => setTab(key) }, text)));
  const size = h('button', { class: 'ghost size', 'aria-label': 'Change text size', onclick: () => {
    S.size = (S.size % 3) + 1;
    applySize(S.size);
    saveSize(S.size);
  } }, 'A+');
  $app.replaceChildren(h('header', null, h('h1', null, 'Vouch'), h('div', { class: 'hgroup' }, $status, size)), $banners, $toast, $content, nav, $overlay);
  paintStatus();
}

function paintStatus() {
  if (!$status) return;
  $status.textContent = S.online ? (S.authed ? 'online' : 'signing in…') : 'offline';
  $status.className = 'pill' + (S.online && S.authed ? '' : ' off');
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
    h('p', null, 'Vouch checks that a message or call asking for money is really from your family or friend.'),
    h('p', { class: 'muted' }, 'Your phone makes a private key. It never leaves this phone.'),
    S.pendingPair ? h('p', { class: 'ok' }, "You'll be linked to your friend right after this.") : null,
    h('label', { for: 'name' }, 'Your name'), name, btn, msg);
}

// ---------- check (the "someone is asking me for money" side) ----------

function checkView() {
  if (!S.friends.length) {
    return h('section', null, h('h2', null, 'Check a message'),
      h('p', null, 'First, link up with someone you trust. Then Vouch can ask their phone.'),
      h('button', { onclick: () => setTab('friends') }, 'Add someone'));
  }
  const F = S.form;
  if (!F.friendId || !friendById(F.friendId)) F.friendId = S.friends[0].id;
  const who = S.friends.length > 1
    ? choice('Who does it say it is?', S.friends.map((f) => [f.id, f.name]), F.friendId, (v) => { F.friendId = v; })
    : h('p', { class: 'big' }, `It says it's ${S.friends[0].name}.`);
  const channel = choice('How did they reach you?', CHANNELS.map(([k, t]) => [k, t]), F.channel, (v) => { F.channel = v; }, 'two');
  const amount = h('input', { id: 'amount', inputmode: 'decimal', placeholder: 'For example 60', value: F.amount, oninput: () => { F.amount = amount.value; } });
  const method = h('select', { id: 'method', onchange: () => { F.method = method.value; } },
    METHODS.map(([k, t]) => h('option', { value: k, selected: k === F.method }, t)));
  const text = h('textarea', { id: 'text', maxlength: '2000', placeholder: 'Optional. Paste what they sent.', value: F.text, oninput: () => { F.text = text.value; } });
  text.value = F.text;
  const msg = h('div', { role: 'alert' });
  const paste = h('button', { class: 'ghost', onclick: async () => {
    try { text.value = (await navigator.clipboard.readText()).slice(0, 2000); F.text = text.value; msg.replaceChildren(); }
    catch { msg.replaceChildren(h('p', { class: 'err' }, 'Press and hold in the box, then tap Paste.')); }
  } }, 'Paste the message');
  const btn = h('button', { onclick: async () => {
    const cents = parseCents(F.amount);
    if (!cents) { msg.replaceChildren(h('p', { class: 'err' }, 'Please type how much they asked for, like 60 or 60.50.')); return; }
    btn.disabled = true;
    msg.replaceChildren();
    try {
      const body = { claimedId: F.friendId, amountCents: cents, method: F.method, channel: F.channel };
      if (F.text.trim()) body.text = F.text.trim();
      const { requestId } = await call('verify:request', body);
      S.current = requestId;
      F.text = ''; F.amount = ''; text.value = ''; amount.value = '';
      renderResult();
      document.getElementById('result')?.scrollIntoView({ block: 'start' });
    } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    btn.disabled = false;
  } }, 'Check now');
  return h('section', null, h('h2', null, 'Is this request real?'),
    h('p', { class: 'muted' }, "We'll ask their real phone. Nothing is sent to them but this question."),
    who, channel,
    h('label', { for: 'amount' }, 'How much do they want? ($)'), amount,
    h('label', { for: 'method' }, 'How do they want it?'), method,
    h('label', { for: 'text' }, 'The message'), text, paste, btn, msg,
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
    attention(`Stop. Do not send money. ${conf.answer === 'not_me' ? `${name} says this was not them.` : 'Something does not add up.'}`, [400, 150, 400, 150, 400]);
  } else if (u.verdict === 'amber' && conf.answer === 'timeout') {
    S.queue.push({ kind: 'alert', data: { u, soft: true } });
    attention(`Wait. ${name} has not answered. Do not send money yet.`, [300, 150, 300]);
  } else if (u.verdict === 'green') {
    attention(`Verified. ${name} confirmed this on their own phone.`, 80);
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
  const title = { green: '✔ Verified. Safe to send.', amber: '✋ Wait.', red: '✖ Do not send.' }[u.verdict];
  const answerText = {
    none: `Waiting for ${name}'s phone…`, yes: `${name} confirmed on their own phone.`,
    not_me: `${name} says this was NOT them.`, timeout: `No reply from ${name}.`,
  }[conf.answer];
  const reasons = (u.reasons || []).length ? h('ul', null, u.reasons.map((r) => h('li', null, r))) : null;
  const card = h('div', { class: 'card' },
    h('div', { class: 'stage' }, h('b', null, '1 · What they asked'),
      h('p', null, `${name} · ${fmt(info.amountCents)} · ${label(METHODS, info.method)} · ${label(CHANNELS, info.channel)}`)),
    h('div', { class: 'stage' }, h('b', null, '2 · What looks suspicious'),
      (und.tags || []).length ? (und.tags).map((t) => h('span', { class: 'chip' }, TAGS[t] || t)) : h('p', null, 'Nothing stands out.'),
      und.paymentRisk ? h('p', null, `Payment risk: ${und.paymentRisk}`) : null,
      und.explanation ? h('p', { class: 'muted' }, und.explanation) : null),
    h('div', { class: 'stage' }, h('b', null, '3 · Did they confirm?'),
      h('p', null, answerText),
      u.needs && u.needs.word ? h('p', null, conf.wordOk ? 'Shared word matched.' : 'Shared word still needed.') : null,
      conf.approvals && conf.approvals.needed ? h('p', null, `Second person: ${conf.approvals.received} of ${conf.approvals.needed}`) : null));
  const parts = [h('div', { class: `verdict ${u.verdict}` }, h('h3', null, title), reasons), card];
  if (u.verdict === 'amber' && conf.answer === 'yes' && u.needs && u.needs.word && !conf.wordOk) parts.push(wordBox(u, name));
  box.replaceChildren(...parts);
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

// ---------- word (the "live call" side) ----------

function wordView() {
  if (!S.friends.length) {
    return h('section', null, h('h2', null, 'On a call?'), h('p', null, 'Link up with someone first to get a word only you two know.'),
      h('button', { onclick: () => setTab('friends') }, 'Add someone'));
  }
  if (!S.wordFriendId || !friendById(S.wordFriendId)) S.wordFriendId = S.friends[0].id;
  const who = S.friends.length > 1
    ? choice('Who is calling?', S.friends.map((f) => [f.id, f.name]), S.wordFriendId, (v) => { S.wordFriendId = v; tickWord(); })
    : null;
  const input = h('input', { id: 'said', placeholder: 'The two words they said', autocapitalize: 'none', autocomplete: 'off' });
  const res = h('div', { role: 'alert' });
  const btn = h('button', { onclick: async () => {
    const f = friendById(S.wordFriendId);
    const ok = f && await checkWord(f.wordKey, input.value);
    res.replaceChildren(h('p', { class: ok ? 'ok' : 'err' }, ok ? '✔ Match. This is really them.' : "✖ No match. Don't trust this call."));
    if (!ok) attention("No match. Don't trust this call.", [400, 150, 400]);
  } }, 'Check what they said');
  queueMicrotask(tickWord);
  return h('section', null, h('h2', null, 'On a call?'),
    h('p', null, 'Ask them: "What\'s our word?" Let them say it first. Never read it out first.'),
    who, h('p', { class: 'muted', style: 'margin-top:1rem' }, 'Your shared word right now:'),
    h('div', { class: 'bigword', id: 'bigword' }, '…'), h('p', { class: 'muted', id: 'wordleft', style: 'text-align:center' }),
    h('label', { for: 'said' }, 'Check what they said'), input, btn, res);
}

async function tickWord() {
  const big = document.getElementById('bigword');
  if (!big || S.tab !== 'word') return;
  const f = friendById(S.wordFriendId);
  if (!f) return;
  const { word, secondsLeft } = await currentWord(f.wordKey);
  big.textContent = word;
  const left = document.getElementById('wordleft');
  if (left) left.textContent = `changes in ${secondsLeft}s`;
}

// ---------- friends + pairing ----------

function friendsView() {
  const list = S.friends.length
    ? h('div', { class: 'card' }, S.friends.map((f) => h('div', { class: 'friend' }, h('span', null, f.name), h('span', { class: 'muted' }, 'linked'))))
    : h('p', { class: 'muted' }, 'Nobody yet.');
  const input = h('input', { id: 'code', placeholder: 'XXXX-XXXX', autocapitalize: 'characters', autocomplete: 'off' });
  const scanBox = h('div');
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
      h('button', { class: 'ghost', onclick: () => startScan(scanBox) }, 'Scan a code')),
    scanBox,
    h('h2', null, 'Your privacy'),
    h('div', { class: 'card' },
      h('p', null, '🔒 Your private key stays on this phone. It cannot be copied out.'),
      h('p', null, '🗑️ Messages you check are never saved. Only the answer is.'),
      h('p', null, '👪 Only people you linked with can ever be asked.')),
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
  await store.saveFriend({ id: peer.id, name: peer.name, signPub: peer.signPub, exchPub: peer.exchPub, wordKey, pairedAt: Date.now() });
  S.friends = await store.listFriends();
  S.codeView = null;
  S.queue.push({ kind: 'paired', peer, code: await safetyCode(S.pubs, peer) });
  renderMain();
}

async function startScan(box) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = h('video', { class: 'scan', playsinline: true, autoplay: true });
    video.muted = true;
    video.srcObject = stream;
    box.replaceChildren(video);
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stopped = false;
    const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); box.replaceChildren(); };
    const loop = async () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = globalThis.jsQR(img.data, img.width, img.height);
        const token = r && r.data && extractToken(r.data);
        if (token) { stop(); await acceptToken(token); return; }
      }
      requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { toast("Couldn't open the camera. Type the code instead."); }
}

// ---------- overlays: pairing code, incoming prompts ----------

function renderOverlay() {
  if (!$overlay) return;
  const item = S.queue[0];
  const key = item ? `${item.kind}:${(item.data && item.data.requestId) || (item.data && item.data.u && item.data.u.requestId) || (item.peer && item.peer.id)}`
    : (S.codeView ? `code:${S.codeView}` : '');
  if ($overlay.dataset.key === key) return; // already showing it; don't wipe what the person is typing
  $overlay.dataset.key = key;
  if (item) $overlay.replaceChildren(overlayFor(item));
  else if (S.codeView) $overlay.replaceChildren(codeOverlay(S.codeView));
  else $overlay.replaceChildren();
  // Move focus into the dialog so screen readers read it first.
  const first = $overlay.querySelector('.inner > *');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
}

function dismiss() { S.queue.shift(); renderOverlay(); }

function overlayFor(item) {
  if (item.kind === 'prompt') return promptOverlay(item.data);
  if (item.kind === 'confirm') return confirmOverlay(item.data);
  if (item.kind === 'alert') return alertOverlay(item.data);
  return pairedOverlay(item);
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
      h('button', { onclick: dismiss }, 'I understand')));
}

function codeOverlay(token) {
  const url = `${location.origin}/#pair=${token}`;
  const canvas = h('canvas', { class: 'qr' });
  drawQr(canvas, url);
  const shown = `${token.slice(0, 4)}-${token.slice(4)}`;
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('h2', null, 'Add a friend'), h('p', null, 'Have them scan this, or type the code.'), canvas,
    h('div', { class: 'code' }, shown), h('p', { class: 'muted' }, 'Waiting for your friend… The code works once and expires in 5 minutes.'),
    h('button', { class: 'ghost', onclick: () => { S.codeView = null; renderOverlay(); } }, 'Cancel')));
}

function drawQr(canvas, text) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 8, margin = 2;
  canvas.width = canvas.height = (n + margin * 2) * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
}

function pairedOverlay({ peer, code }) {
  return h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'inner' },
    h('h2', null, `Paired with ${peer.name}`),
    h('p', null, 'Read this code out loud to each other. If it matches on both phones, you are safely paired.'),
    h('div', { class: 'code' }, code),
    h('button', { onclick: dismiss }, 'It matches')));
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
    renderOverlay();
  });
  on('verify:confirm_prompt', (p) => {
    if (S.queue.some((q) => q.kind === 'confirm' && q.data.requestId === p.requestId)) return;
    S.queue.push({ kind: 'confirm', data: p });
    attention(`${p.checkerName} needs a second opinion about ${p.claimedName}.`, [300, 150, 300]);
    renderOverlay();
  });
  on('pair:completed', (msg) => { if (msg && msg.peer) onPeerPaired(msg.peer); });
  on('circle:alert', (a) => {
    const box = h('div', { class: 'banner' }, `Warning: someone may be pretending to be ${a.impersonatedName}. Don't send money.`);
    box.append(h('button', { onclick: () => box.remove() }, 'Dismiss'));
    $banners.append(box);
  });
  on('demo:reset', async (d) => {
    if (d && d.hard) { try { await store.resetAll(); } catch { /* reload anyway */ } location.reload(); return; }
    S.results.clear(); S.current = null; S.queue.length = 0;
    renderMain();
  });
}

boot();
