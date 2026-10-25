import { TAG_LIST, METHOD_RISK } from '../config.js';

// Rules-only scam analysis. No network, no AI, never throws. Gemini (gemini.js) may only ADD tags on top of these.
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
const maxRisk = (a, b) => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);
const MAX_TEXT = 5000;

const normalize = (text) =>
  String(text ?? '').slice(0, MAX_TEXT).toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

// Each detector matches normalized (lowercase, straight-apostrophe) text.
const DETECTORS = {
  URGENCY: [
    /\b(urgent(ly)?|asap|immediately|hurry|emergency|time[- ]sensitive|right away|right now|quickly)\b/,
    /\brn\b/,
    /\bneed(s|ed)? (it|this|that|them|the money|money|cash)? ?(today|tonight|now)\b/,
    /\b(before|until) (it'?s )?too late\b/,
    /\bin the next \d+ (min|mins|minutes|hour|hours)\b/,
  ],
  SECRECY: [
    /\b(don'?t|do not) (tell|mention|breathe a word|say (anything|a word)|let (anyone|anybody|mom|dad|him|her|them))/,
    /\bkeep (this|it|that) (a )?(secret|quiet|private|between us|to yourself)/,
    /\bbetween (us|you and me)\b/,
    /\b(our|a) (little )?secret\b/,
    /\bno ?one (can|needs to|should) know\b/,
    /\bdelete (this|these|the) (message|messages|text|texts|chat)\b/,
  ],
  NEW_NUMBER: [
    /\b(new|different) (phone )?number\b/,
    /\bnew phone\b/,
    /\bchanged my (phone )?number\b/,
    /\bnumber (changed|got changed)\b/,
    /\blost my phone\b/,
    /\b(my )?phone (broke|died|cracked|got stolen|is broken)\b/,
    /\b(using|texting from|on) (a |my )?(friend'?s|someone'?s|borrowed) (phone|number)\b/,
  ],
  GIFT_CARD: [
    /\bgift ?cards?\b/,
    /\b(itunes|google play|steam|amazon|target|apple|walmart|ebay) (gift )?(cards?|codes?)\b/,
    /\bsteam wallet\b/,
    /\bitunes\b/,
    /\b(scratch off|scratch the back)\b/,
  ],
  WIRE: [
    /\bwire (me|it|us|him|her|them|the|a|some|my|your|money|funds|transfer|\$)/,
    /\bwired (me|it|us|the|money|funds)\b/,
    /\b(by|via|through|over) (a )?wire\b/,
    /\bwire transfer\b/,
    /\bwestern union\b/,
    /\bmoney ?gram\b/,
    /\b(bank|international) transfer\b/,
    /\brouting number\b/,
  ],
  CRYPTO: [
    /\b(bitcoin|btc|ethereum|usdt|tether|crypto(currency)?|coinbase|binance|dogecoin)\b/,
    /\bbitcoin atm\b/,
    /\bwallet address\b/,
  ],
  PAYBACK_PROMISE: [
    /\b(pay|paying|paid|repay|send|give|get) (you|it|that|this|the money) back\b/,
    /\b(venmo|zelle|cash ?app|paypal) (you|it) back\b/,
    /\brepay(ing)? you\b/,
    /\b(double|triple|10x) (it|your money|what you send|the money)\b/,
    /\bi'?ll make it up to you\b/,
    /\bi'?ll return it\b/,
  ],
};

export function detectTags(text, { firstRequest = false } = {}) {
  const t = normalize(text);
  const found = new Set();
  for (const [tag, patterns] of Object.entries(DETECTORS)) {
    if (patterns.some((p) => p.test(t))) found.add(tag);
  }
  if (firstRequest === true) found.add('FIRST_REQUEST');
  return TAG_LIST.filter((tag) => found.has(tag));
}

// Payment keywords in the text. 'high' beats 'medium'; null when nothing is mentioned.
const HIGH_TAGS = ['GIFT_CARD', 'WIRE', 'CRYPTO']; // the same patterns as the tags, so a bare "steam" or "wire" does not count
const MEDIUM_WORDS = /\b(zelle|venmo|cash ?app|paypal|apple cash)\b/;

export function inferPaymentRisk(text) {
  const t = normalize(text);
  if (HIGH_TAGS.some((tag) => DETECTORS[tag].some((p) => p.test(t)))) return 'high';
  if (MEDIUM_WORDS.test(t)) return 'medium';
  return null;
}

// The higher of the selector value and what the text suggests. Unknown selector values count as 'low'.
export function paymentRiskFor(paymentMethod, text) {
  const selected = METHOD_RISK[paymentMethod] || 'low';
  const inferred = inferPaymentRisk(text);
  return inferred ? maxRisk(selected, inferred) : selected;
}

// First dollar amount in the text, in dollars: "$60", "$ 60.50", "$1,200", "$2k", "60 dollars", "60 bucks", "60 usd".
// Returns null when there is none. Money is never guessed from bare numbers.
export function extractAmount(text) {
  const t = String(text ?? '').slice(0, MAX_TEXT).toLowerCase();
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?(k\b)?/.exec(t)
    || /\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?(k\b)?\s?(dollars?|bucks|usd)\b/.exec(t);
  if (!m) return null;
  const value = Number(`${m[1].replace(/,/g, '')}${m[2] || ''}`) * (m[3] ? 1000 : 1);
  return Number.isFinite(value) ? value : null;
}

const TAG_WORDS = {
  URGENCY: 'pressure to hurry', SECRECY: 'asks you to keep it secret', NEW_NUMBER: 'a new number or phone',
  GIFT_CARD: 'gift cards', WIRE: 'a wire transfer', CRYPTO: 'crypto',
  PAYBACK_PROMISE: 'a promise to pay you back', FIRST_REQUEST: 'first time asking',
};

export function explain(tags) {
  if (!tags.length) return 'No common scam wording found. Only a signed Yes from your friend counts.';
  return `Warning signs: ${tags.map((t) => TAG_WORDS[t]).join(', ')}.`.slice(0, 140);
}

// Deterministic result in the analyze() shape. Safe on any input.
export function analyzeRules(input) {
  const i = input && typeof input === 'object' ? input : {};
  const text = typeof i.text === 'string' ? i.text : '';
  const tags = detectTags(text, { firstRequest: i.firstRequest });
  const paymentRisk = paymentRiskFor(i.paymentMethod, text);
  const amount = Number.isFinite(i.amount) ? i.amount : extractAmount(text);
  return { tags, paymentRisk, amount, explanation: explain(tags), source: 'rules' };
}
