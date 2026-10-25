// Shared thresholds. Placeholders until the study gives real numbers. Money is integer cents (PROTOCOL v2).
export const TIER2_MIN_CENTS = 2500;    // T1: amountCents < 2500
export const TIER3_MIN_CENTS = 20001;   // T3: amountCents > 20000
export const TIMEOUT_MS = 120000;
export const PAUSE_SECONDS = 10;        // enforced on the phone, listed here so the team has one place for it
export const HIGH_RISK_TAG_COUNT = 2;
export const GEMINI_TIMEOUT_MS = 3000;

// Server-only limits
export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_TS_AGE_MS = 5 * 60 * 1000;
export const RATE_LIMIT_PER_MIN = 5;
export const PAIR_ATTEMPTS_PER_MIN = 10;
export const OFFERS_PER_MIN = 20;
export const REGISTER_PER_MIN = 60; // per client address; a whole expo table shares one hotspot address
export const MAX_TEXT_CHARS = 2000;
export const MAX_IMAGE_DATAURL_CHARS = 4 * 1024 * 1024;
export const MAX_AMOUNT_CENTS = 10_000_000_00;
export const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const CHANNELS = ['text', 'call', 'dm', 'email'];

export const TAG_LIST = [
  'URGENCY', 'SECRECY', 'NEW_NUMBER', 'GIFT_CARD',
  'WIRE', 'CRYPTO', 'PAYBACK_PROMISE', 'FIRST_REQUEST',
];

export const METHOD_RISK = {
  gift_card: 'high',
  wire: 'high',
  crypto: 'high',
  venmo_cashapp_zelle: 'medium',
  cash_in_person: 'low',
  other: 'low',
  unknown: 'low',
};
