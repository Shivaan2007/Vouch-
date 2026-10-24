// Shared thresholds (contracts, section 2). Placeholders until the study gives real numbers.
export const TIER1_MAX = 25;
export const TIER2_MAX = 200;
export const TIMEOUT_MS = 120000;
export const PAUSE_SECONDS = 10;
export const HIGH_RISK_TAG_COUNT = 2;
export const GEMINI_TIMEOUT_MS = 3000;

// Server-only limits
export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_TS_AGE_MS = 5 * 60 * 1000;
export const RATE_LIMIT_PER_MIN = 5;
export const MAX_IMAGE_BASE64_CHARS = 5.6 * 1024 * 1024; // about 4 MB of image
export const MAX_AMOUNT = 1_000_000;

export const TAG_LIST = [
  'URGENCY', 'SECRECY', 'NEW_NUMBER', 'GIFT_CARD',
  'WIRE', 'CRYPTO', 'PAYBACK_PROMISE', 'FIRST_REQUEST',
];

// Payment method selector values -> risk
export const METHOD_RISK = {
  gift_card: 'high',
  wire: 'high',
  crypto: 'high',
  venmo_cashapp_zelle: 'medium',
  cash_in_person: 'low',
  other: 'low',
  unknown: 'low',
};
