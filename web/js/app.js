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

// ---------- state ----------

const S = {
  me: null, keys: null, pubs: null, nonce: null, authed: false, online: false,
  friends: [], tab: 'check', pendingPair: null, current: null, results: new Map(),
  drafts: {}, queue: [], codeView: null, wordFriendId: null, form: { friendId: '', method: 'venmo_cashapp_zelle', channel: 'text' },
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
  $status = h('span', { class: 'pill off' }, 'offline');
  $banners = h('div');
  $toast = h('div');
  $content = h('main');
  $overlay = h('div');
  const tabs = [['check', 'Check'], ['word', 'Word'], ['friends', 'Friends']];
  const nav = h('nav', { id: 'nav' }, tabs.map(([key, text]) =>
    h('button', { 'data-tab': key, onclick: () => setTab(key) }, text)));
  $app.replaceChildren(h('header', null, h('h1', null, 'Vouch'), $status), $banners, $toast, $content, nav, $overlay);
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
  const name = h('input', { maxlength: '20', placeholder: 'Your first name', autocomplete: 'given-name' });
  const msg = h('div');
  const btn = h('button', { onclick: async () => {
    const v = name.value.trim();
    if (!v) { msg.replaceChildren(h('p', { class: 'err' }, 'Enter your name.')); return; }
    btn.disabled = true;
    try { await register(v); } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); btn.disabled = false; }
  } }, 'Get started');
  return h('section', null,
    h('h2', null, 'Welcome'),
    h('p', { class: 'muted' }, 'Vouch checks that a friend really asked you for money. Your phone makes a private key that never leaves it.'),
    S.pendingPair ? h('p', { class: 'ok' }, "You'll be paired with your friend right after this.") : null,
    h('label', null, 'Your name'), name, btn, msg);
}

// ---------- check (the "someone is asking me for money" side) ----------

function checkView() {
  if (!S.friends.length) {
    return h('section', null, h('h2', null, 'Check a request'),
      h('p', null, 'Pair with a friend first, so Vouch can ask their phone.'),
      h('button', { onclick: () => setTab('friends') }, 'Add a friend'));
  }
  if (!S.form.friendId || !friendById(S.form.friendId)) S.form.friendId = S.friends[0].id;
  const who = h('select', { onchange: () => { S.form.friendId = who.value; } },
    S.friends.map((f) => h('option', { value: f.id, selected: f.id === S.form.friendId }, f.name)));
  const amount = h('input', { inputmode: 'decimal', placeholder: '60' });
  const method = h('select', { onchange: () => { S.form.method = method.value; } },
    METHODS.map(([k, t]) => h('option', { value: k, selected: k === S.form.method }, t)));
  const channel = h('select', { onchange: () => { S.form.channel = channel.value; } },
    CHANNELS.map(([k, t]) => h('option', { value: k, selected: k === S.form.channel }, t)));
  const text = h('textarea', { maxlength: '2000', placeholder: 'Optional: paste the message they sent' });
  const msg = h('div');
  const btn = h('button', { onclick: async () => {
    const cents = parseCents(amount.value);
    if (!cents) { msg.replaceChildren(h('p', { class: 'err' }, 'Enter the amount they asked for, like 60 or 60.50.')); return; }
    btn.disabled = true;
    msg.replaceChildren();
    try {
      const body = { claimedId: who.value, amountCents: cents, method: method.value, channel: channel.value };
      if (text.value.trim()) body.text = text.value.trim();
      const { requestId } = await call('verify:request', body);
      S.current = requestId;
      text.value = '';
      renderResult();
    } catch (e) { msg.replaceChildren(h('p', { class: 'err' }, friendly(e))); }
    btn.disabled = false;
  } }, 'Check with their phone');
  return h('section', null, h('h2', null, 'Someone is asking me for money'),
    h('p', { class: 'muted' }, 'Pick who they claim to be. Their real phone will be asked.'),
    h('label', null, 'Who is it?'), who,
    h('label', null, 'How much do they want? ($)'), amount,
    h('label', null, 'How do they want it?'), method,
    h('label', null, 'Where did it come from?'), channel,
    h('label', null, 'Message'), text, btn, msg,
    h('div', { id: 'result' }));
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
  if (S.current === u.requestId) renderResult();
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
  const title = { green: 'Verified. Safe to send.', amber: 'Hold on.', red: "Don't send." }[u.verdict];
  const answerText = {
    none: `Waiting for ${name}'s phone…`, yes: `${name} confirmed on their own phone.`,
    not_me: `${name} says this was NOT them.`, timeout: `No reply from ${name}.`,
  }[conf.answer];
  const reasons = (u.reasons || []).length ? h('ul', null, u.reasons.map((r) => h('li', null, r))) : null;
  const card = h('div', { class: 'card' },
    h('div', { class: 'stage' }, h('b', null, '1 · Information'),
      h('p', null, `${name} · ${fmt(info.amountCents)} · ${label(METHODS, info.method)} · ${label(CHANNELS, info.channel)}`)),
    h('div', { class: 'stage' }, h('b', null, '2 · Understanding'),
      (und.tags || []).map((t) => h('span', { class: 'chip' }, TAGS[t] || t)),
      und.paymentRisk ? h('p', null, `Payment risk: ${und.paymentRisk}`) : null,
      und.explanation ? h('p', { class: 'muted' }, und.explanation) : null),
    h('div', { class: 'stage' }, h('b', null, '3 · Confidence'),
      h('p', null, answerText),
      u.needs && u.needs.word ? h('p', null, conf.wordOk ? 'Word check passed.' : 'Word check needed.') : null,
      conf.approvals && conf.approvals.needed ? h('p', null, `Second approval: ${conf.approvals.received}/${conf.approvals.needed}`) : null));
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
    return h('section', null, h('h2', null, 'Shared word'), h('p', null, 'Pair with a friend to get a word only you two know.'),
      h('button', { onclick: () => setTab('friends') }, 'Add a friend'));
  }
  if (!S.wordFriendId || !friendById(S.wordFriendId)) S.wordFriendId = S.friends[0].id;
  const who = h('select', { onchange: () => { S.wordFriendId = who.value; tickWord(); } },
    S.friends.map((f) => h('option', { value: f.id, selected: f.id === S.wordFriendId }, f.name)));
  const input = h('input', { placeholder: 'What they said', autocapitalize: 'none', autocomplete: 'off' });
  const res = h('div');
  const btn = h('button', { class: 'ghost', onclick: async () => {
    const f = friendById(S.wordFriendId);
    const ok = f && await checkWord(f.wordKey, input.value);
    res.replaceChildren(h('p', { class: ok ? 'ok' : 'err' }, ok ? "Match. That's really them." : "No match. Don't trust this call."));
  } }, 'Check what they said');
  queueMicrotask(tickWord);
  return h('section', null, h('h2', null, 'Shared word'),
    h('p', { class: 'muted' }, 'On a call, ask "What\'s our word?" You should both see the same two words. It changes every minute.'),
    who, h('div', { class: 'bigword', id: 'bigword' }, '…'), h('p', { class: 'muted', id: 'wordleft', style: 'text-align:center' }),
    h('label', null, 'Check what they said'), input, btn, res);
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
    ? h('div', { class: 'card' }, S.friends.map((f) => h('div', { class: 'friend' }, h('span', null, f.name))))
    : h('p', { class: 'muted' }, 'No friends yet.');
  const input = h('input', { placeholder: 'XXXX-XXXX', autocapitalize: 'characters', autocomplete: 'off' });
  const scanBox = h('div');
  return h('section', null, h('h2', null, `Hi ${S.me.name}`),
    h('h2', null, 'Your circle'), list,
    h('button', { onclick: showMyCode }, 'Add a friend (show my code)'),
    h('h2', null, 'Have a code?'), input,
    h('div', { class: 'row' },
      h('button', { onclick: async () => { const t = extractToken(input.value); if (t) await acceptToken(t); } }, 'Join'),
      h('button', { class: 'ghost', onclick: () => startScan(scanBox) }, 'Scan QR')),
    scanBox);
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
  if (item) { $overlay.replaceChildren(overlayFor(item)); return; }
  if (S.codeView) { $overlay.replaceChildren(codeOverlay(S.codeView)); return; }
  $overlay.replaceChildren();
}

function dismiss() { S.queue.shift(); renderOverlay(); }

function overlayFor(item) {
  if (item.kind === 'prompt') return promptOverlay(item.data);
  if (item.kind === 'confirm') return confirmOverlay(item.data);
  return pairedOverlay(item);
}

function codeOverlay(token) {
  const url = `${location.origin}/#pair=${token}`;
  const canvas = h('canvas', { class: 'qr' });
  drawQr(canvas, url);
  const shown = `${token.slice(0, 4)}-${token.slice(4)}`;
  return h('div', { class: 'overlay' }, h('div', { class: 'inner' },
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
  return h('div', { class: 'overlay' }, h('div', { class: 'inner' },
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
  return h('div', { class: 'overlay' }, h('div', { class: 'inner' },
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
  return h('div', { class: 'overlay' }, h('div', { class: 'inner' },
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
    renderOverlay();
  });
  on('verify:confirm_prompt', (p) => {
    if (S.queue.some((q) => q.kind === 'confirm' && q.data.requestId === p.requestId)) return;
    S.queue.push({ kind: 'confirm', data: p });
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
