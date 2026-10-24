import crypto from 'node:crypto';

// WebCrypto ECDSA P-256 signatures are raw r||s (IEEE P1363), not DER (gotcha 1).
// Public keys arrive as base64 SPKI (DER).
export function verifySig(signPubB64, message, sigB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(signPubB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

// Exact signed string, shared with the phones (contracts, section 2).
export const answerString = (requestId, answer, ts, nonce) => `${requestId}|${answer}|${ts}|${nonce}`;

// Login challenge is signed with a prefix so it can never double as an answer signature.
export const loginString = (userId, challenge) => `login|${userId}|${challenge}`;

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
