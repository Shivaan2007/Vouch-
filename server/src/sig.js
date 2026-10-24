import crypto from 'node:crypto';

// WebCrypto ECDSA P-256 signatures are raw r||s (IEEE P1363), not DER (PROTOCOL §0).
// Public keys arrive as base64 SPKI DER. Signed strings come from web/js/lib/canonical.js, never built here.
export function verifySig(signPubB64, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(signPubB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export function isP256Spki(b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch { return false; }
}

export const newId = () => crypto.randomBytes(16).toString('hex'); // 32 lowercase hex chars
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Hash of the normalized text (lowercase, whitespace collapsed). The text itself is never stored.
export const normalizeText = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
