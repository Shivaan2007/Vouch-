// Canonical signed strings and encoding helpers (PROTOCOL v2 §0). Pure: no DOM, no IndexedDB.
// Imported by phones AND the server. Never change the signed string formats.

export const PROTOCOL_VERSION = 'v2';

export const METHODS = ['gift_card', 'wire', 'crypto', 'venmo_cashapp_zelle', 'cash_in_person', 'other', 'unknown'];
export const ANSWERS = ['yes', 'not_me'];
export const CONFIRM_ANSWERS = ['yes', 'no'];

const enc = new TextEncoder();

/** UTF-8 encode a string to bytes. */
export function utf8(str) {
  return enc.encode(String(str));
}

/** Bytes (Uint8Array/ArrayBuffer) to base64. */
export function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/** Base64 to Uint8Array. Throws on invalid input. */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes to lowercase hex. */
export function bytesToHex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/** 16 random bytes as lowercase hex, from the platform CSPRNG. */
export function randomNonce() {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

function needStr(name, v) {
  if (typeof v !== 'string' || v === '' || v.includes('|')) {
    throw new TypeError(`${name} must be a non-empty string without "|"`);
  }
  return v;
}

function needInt(name, v) {
  if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer`);
  return v;
}

function needOneOf(name, v, allowed) {
  if (!allowed.includes(v)) throw new TypeError(`${name} must be one of ${allowed.join('|')}`);
  return v;
}

/** `vouch|v2|auth|{nonce}` */
export function authString(nonce) {
  return `vouch|${PROTOCOL_VERSION}|auth|${needStr('nonce', nonce)}`;
}

/** `vouch|v2|answer|{requestId}|{checkerId}|{claimedId}|{amountCents}|{method}|{answer}|{ts}|{nonce}` */
export function answerString(f) {
  if (!f || typeof f !== 'object') throw new TypeError('fields required');
  return [
    'vouch', PROTOCOL_VERSION, 'answer',
    needStr('requestId', f.requestId),
    needStr('checkerId', f.checkerId),
    needStr('claimedId', f.claimedId),
    needInt('amountCents', f.amountCents),
    needOneOf('method', f.method, METHODS),
    needOneOf('answer', f.answer, ANSWERS),
    needInt('ts', f.ts),
    needStr('nonce', f.nonce),
  ].join('|');
}

/** `vouch|v2|confirm|{requestId}|{confirmerId}|{claimedId}|{amountCents}|{answer}|{ts}|{nonce}` */
export function confirmString(f) {
  if (!f || typeof f !== 'object') throw new TypeError('fields required');
  return [
    'vouch', PROTOCOL_VERSION, 'confirm',
    needStr('requestId', f.requestId),
    needStr('confirmerId', f.confirmerId),
    needStr('claimedId', f.claimedId),
    needInt('amountCents', f.amountCents),
    needOneOf('answer', f.answer, CONFIRM_ANSWERS),
    needInt('ts', f.ts),
    needStr('nonce', f.nonce),
  ].join('|');
}

/** Message HMAC'd for the rotating word (PROTOCOL §4). */
export function wordMessage(minute) {
  return `vouch-word|${PROTOCOL_VERSION}|${needInt('minute', minute)}`;
}
