// Vouch crypto (PROTOCOL v2). No DOM, no IndexedDB: runs unchanged in Node 20 and browsers.
// Uses only globalThis.crypto (subtle + getRandomValues). Never logs keys, secrets, MACs or signatures.

import { WORDS } from './words.js';
import {
  answerString, confirmString, wordMessage, bytesToB64, b64ToBytes, utf8, randomNonce,
} from './canonical.js';

const subtle = () => globalThis.crypto.subtle;
const SIGN_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };
const EXCH_ALG = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * Generate a device identity: ECDSA signing pair and ECDH exchange pair.
 * Private keys are non-extractable; public keys can still be exported.
 * @returns {Promise<{signKeyPair: CryptoKeyPair, exchKeyPair: CryptoKeyPair}>}
 */
export async function createIdentityKeys() {
  const signKeyPair = await subtle().generateKey(SIGN_ALG, false, ['sign', 'verify']);
  const exchKeyPair = await subtle().generateKey(EXCH_ALG, false, ['deriveKey']);
  return { signKeyPair, exchKeyPair };
}

/**
 * Export a public key as base64 SPKI DER.
 * @param {CryptoKey} publicKey
 * @returns {Promise<string>}
 */
export async function exportPub(publicKey) {
  return bytesToB64(await subtle().exportKey('spki', publicKey));
}

/**
 * Sign a string with ECDSA P-256 / SHA-256.
 * @param {CryptoKey} privateKey
 * @param {string} str
 * @returns {Promise<string>} base64 raw r||s (64 bytes)
 */
export async function signString(privateKey, str) {
  return bytesToB64(await subtle().sign(SIGN_PARAMS, privateKey, utf8(str)));
}

/**
 * Verify a base64 raw signature over a string. Never throws.
 * @param {string} signPubB64 base64 SPKI ECDSA public key
 * @param {string} sigB64
 * @param {string} str
 * @returns {Promise<boolean>}
 */
export async function verifyString(signPubB64, sigB64, str) {
  try {
    const key = await subtle().importKey('spki', b64ToBytes(signPubB64), SIGN_ALG, false, ['verify']);
    return await subtle().verify(SIGN_PARAMS, key, b64ToBytes(sigB64), utf8(str));
  } catch {
    return false;
  }
}

/**
 * Derive the shared, non-extractable HMAC key used for the rotating word.
 * @param {CryptoKey} myExchPrivateKey
 * @param {string} friendExchPubB64 base64 SPKI ECDH public key
 * @returns {Promise<CryptoKey>}
 */
export async function deriveWordKey(myExchPrivateKey, friendExchPubB64) {
  const pub = await subtle().importKey('spki', b64ToBytes(friendExchPubB64), EXCH_ALG, false, []);
  return subtle().deriveKey(
    { name: 'ECDH', public: pub },
    myExchPrivateKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/**
 * The two-word phrase for a given minute.
 * @param {CryptoKey} wordKey
 * @param {number} minute Math.floor(ms / 60000)
 * @returns {Promise<string>}
 */
export async function wordAt(wordKey, minute) {
  const mac = new Uint8Array(await subtle().sign('HMAC', wordKey, utf8(wordMessage(minute))));
  const n = WORDS.length;
  return `${WORDS[((mac[0] << 8) | mac[1]) % n]} ${WORDS[((mac[2] << 8) | mac[3]) % n]}`;
}

/**
 * The current phrase plus its minute and seconds until it rotates.
 * @param {CryptoKey} wordKey
 * @param {number} [now=Date.now()]
 * @returns {Promise<{word: string, minute: number, secondsLeft: number}>}
 */
export async function currentWord(wordKey, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  return {
    word: await wordAt(wordKey, minute),
    minute,
    secondsLeft: 60 - Math.floor((now % 60000) / 1000),
  };
}

/**
 * Check a spoken phrase against the current and previous minute.
 * @param {CryptoKey} wordKey
 * @param {string} typed
 * @param {number} [now=Date.now()]
 * @returns {Promise<boolean>}
 */
export async function checkWord(wordKey, typed, now = Date.now()) {
  if (typeof typed !== 'string') return false;
  const norm = typed.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  const minute = Math.floor(now / 60000);
  return norm === (await wordAt(wordKey, minute)) || norm === (await wordAt(wordKey, minute - 1));
}

/**
 * Six-digit safety code both phones show after pairing, e.g. "123 456". Symmetric in A/B.
 * @param {{signPub: string, exchPub: string}} pubsA
 * @param {{signPub: string, exchPub: string}} pubsB
 * @returns {Promise<string>}
 */
export async function safetyCode(pubsA, pubsB) {
  const input = [pubsA.signPub, pubsB.signPub].sort().join('|') + '|' + [pubsA.exchPub, pubsB.exchPub].sort().join('|');
  const h = new Uint8Array(await subtle().digest('SHA-256', utf8(input)));
  const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/**
 * Re-verify a verify:update's answer signature against the friend's saved signPub.
 * Rebuilds the answer string from the payload; false if anything is missing or invalid.
 * @param {object} update verify:update payload
 * @param {string} friendSignPub base64 SPKI
 * @returns {Promise<boolean>}
 */
export async function verifyAnswer(update, friendSignPub) {
  try {
    const info = update.stages.information;
    const conf = update.stages.confidence;
    const a = conf && conf.answerSig;
    if (!a || !a.sig || conf.answer !== a.answer) return false;
    const str = answerString({
      requestId: update.requestId,
      checkerId: update.checkerId,
      claimedId: update.claimedId,
      amountCents: info.amountCents,
      method: info.method,
      answer: a.answer,
      ts: a.ts,
      nonce: a.nonce,
    });
    return await verifyString(friendSignPub, a.sig, str);
  } catch {
    return false;
  }
}

/**
 * Sign a verify:answer. Adds ts and nonce.
 * @param {CryptoKey} signPrivateKey
 * @param {{requestId: string, checkerId: string, claimedId: string, amountCents: number, method: string, answer: string}} fields
 * @returns {Promise<{ts: number, nonce: string, sig: string}>}
 */
export async function signAnswer(signPrivateKey, fields) {
  const ts = Date.now();
  const nonce = randomNonce();
  const sig = await signString(signPrivateKey, answerString({ ...fields, ts, nonce }));
  return { ts, nonce, sig };
}

/**
 * Sign a verify:confirm. Adds ts and nonce.
 * @param {CryptoKey} signPrivateKey
 * @param {{requestId: string, confirmerId: string, claimedId: string, amountCents: number, answer: string}} fields
 * @returns {Promise<{ts: number, nonce: string, sig: string}>}
 */
export async function signConfirm(signPrivateKey, fields) {
  const ts = Date.now();
  const nonce = randomNonce();
  const sig = await signString(signPrivateKey, confirmString({ ...fields, ts, nonce }));
  return { ts, nonce, sig };
}
