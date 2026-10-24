import { WORDS } from '../js/lib/words.js';
import { randomNonce } from '../js/lib/canonical.js';
import {
  createIdentityKeys, exportPub, signString, verifyString, deriveWordKey, wordAt, currentWord,
  checkWord, safetyCode, verifyAnswer, signAnswer,
} from '../js/lib/crypto.js';
import { getKeys, saveKeys, getIdentity, saveIdentity, resetAll } from '../js/lib/store.js';

const out = document.getElementById('out');
document.getElementById('env').textContent = (navigator.userAgent || '').slice(0, 120) + ' | secure=' + String(globalThis.isSecureContext);

function line(ok, text) {
  const d = document.createElement('div');
  d.className = ok ? 'pass' : 'fail';
  d.textContent = (ok ? 'PASS ' : 'FAIL ') + text;
  out.appendChild(d);
}
function info(text) {
  const d = document.createElement('div');
  d.textContent = text;
  out.appendChild(d);
}
function clear() { out.textContent = ''; }

async function check(name, fn) {
  try { line(!!(await fn()), name); } catch (e) { line(false, name + ' (' + (e && e.message) + ')'); }
}

async function makeUser() {
  const keys = await createIdentityKeys();
  return { keys, signPub: await exportPub(keys.signKeyPair.publicKey), exchPub: await exportPub(keys.exchKeyPair.publicKey) };
}

async function runTests() {
  clear();
  await check('WORDS 1296 unique, acid..zoom', () => WORDS.length === 1296 && new Set(WORDS).size === 1296 && WORDS[0] === 'acid' && WORDS[1295] === 'zoom');
  const a = await makeUser();
  const b = await makeUser();
  await check('sign/verify + tamper', async () => {
    const sig = await signString(a.keys.signKeyPair.privateKey, 'hello');
    return (await verifyString(a.signPub, sig, 'hello')) && !(await verifyString(a.signPub, sig, 'hellO')) && !(await verifyString('junk', sig, 'hello'));
  });
  const ka = await deriveWordKey(a.keys.exchKeyPair.privateKey, b.exchPub);
  const kb = await deriveWordKey(b.keys.exchKeyPair.privateKey, a.exchPub);
  await check('both phones derive same word (5 minutes)', async () => {
    const m = Math.floor(Date.now() / 60000);
    for (let i = 0; i < 5; i++) if ((await wordAt(ka, m + i)) !== (await wordAt(kb, m + i))) return false;
    return true;
  });
  await check('checkWord current/prev (case, spaces)', async () => {
    const now = Date.now();
    const m = Math.floor(now / 60000);
    const cur = await wordAt(ka, m);
    return (await checkWord(kb, '  ' + cur.toUpperCase() + ' ', now)) && (await checkWord(kb, await wordAt(ka, m - 1), now));
  });
  await check('safety code symmetric', async () => {
    const c = await safetyCode(a, b);
    return c === (await safetyCode(b, a)) && /^\d{3} \d{3}$/.test(c);
  });
  await check('verifyAnswer ok + tamper', async () => {
    const f = { requestId: 'r1', checkerId: 'c1', claimedId: 'f1', amountCents: 6000, method: 'wire', answer: 'yes' };
    const s = await signAnswer(a.keys.signKeyPair.privateKey, f);
    const u = (amt) => ({ requestId: 'r1', checkerId: 'c1', claimedId: 'f1', stages: { information: { amountCents: amt, method: 'wire' }, confidence: { answer: 'yes', answerSig: { answer: 'yes', ...s } } } });
    return (await verifyAnswer(u(6000), a.signPub)) && !(await verifyAnswer(u(6001), a.signPub));
  });
  await check('private keys non-extractable', async () => {
    try { await crypto.subtle.exportKey('pkcs8', a.keys.signKeyPair.privateKey); return false; } catch { return true; }
  });
  info('Done.');
}

document.getElementById('run').onclick = runTests;

document.getElementById('create').onclick = async () => {
  clear();
  try {
    const keys = await createIdentityKeys();
    await saveKeys(keys);
    await saveIdentity({ id: randomNonce(), name: 'Test' });
    line(true, 'Identity saved to IndexedDB. Now reload this page, then tap "Reload → load identity and sign".');
  } catch (e) { line(false, 'create/save: ' + (e && e.message)); }
};

document.getElementById('reload').onclick = async () => {
  clear();
  try {
    const keys = await getKeys();
    const ident = await getIdentity();
    if (!keys || !ident) { line(false, 'Nothing saved. Tap "Create + save identity" first.'); return; }
    const pub = await exportPub(keys.signKeyPair.publicKey);
    const msg = 'reload-test|' + randomNonce();
    const sig = await signString(keys.signKeyPair.privateKey, msg);
    line(await verifyString(pub, sig, msg), 'loaded keys from IndexedDB and signed (id ' + ident.id.slice(0, 6) + '…)');
    let extractable = true;
    try { await crypto.subtle.exportKey('pkcs8', keys.signKeyPair.privateKey); } catch { extractable = false; }
    line(!extractable, 'private key still non-extractable after reload');
  } catch (e) { line(false, 'load/sign: ' + (e && e.message)); }
};

document.getElementById('reset').onclick = async () => {
  clear();
  try { await resetAll(); line(true, 'Cleared.'); } catch (e) { line(false, 'reset: ' + (e && e.message)); }
};

(async function liveWords() {
  const a = await makeUser();
  const b = await makeUser();
  const ka = await deriveWordKey(a.keys.exchKeyPair.privateKey, b.exchPub);
  const kb = await deriveWordKey(b.keys.exchKeyPair.privateKey, a.exchPub);
  async function tick() {
    const x = await currentWord(ka);
    const y = await currentWord(kb);
    document.getElementById('wA').textContent = 'A: ' + x.word;
    document.getElementById('wB').textContent = 'B: ' + y.word + (x.word === y.word ? '  ✓ match' : '  ✗ MISMATCH');
    document.getElementById('left').textContent = x.secondsLeft + 's left';
  }
  await tick();
  setInterval(tick, 1000);
})();
