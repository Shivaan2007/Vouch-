// Instant scam hints, on the phone (and in the message bot). Pure: no DOM, no network, runs in browsers and Node.
// These only WARN and pre-fill forms. They never clear anything: only the friend's signed answer can make a request green.
// The server's risk layer (server/src/risk, rules + Gemini) is the authoritative analysis; this is the fast first look.

export const TAG_LABELS = {
  URGENCY: 'Pressure to act fast', SECRECY: 'Asks you to keep it secret', NEW_NUMBER: 'New number',
  GIFT_CARD: 'Gift cards', WIRE: 'Wire transfer', CRYPTO: 'Crypto', PAYBACK_PROMISE: 'Promises to pay back',
  FIRST_REQUEST: "First time they've asked",
};

const norm = (text) => String(text ?? '').slice(0, 5000).toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const RULES = [
  ['GIFT_CARD', [/gift ?cards?/, /\b(itunes|google play|steam|amazon|target|apple|walmart|ebay) (gift )?(cards?|codes?)\b/, /\bitunes\b/]],
  ['WIRE', [/\b(by|via|through|over) (a )?wire\b/, /\bwire (me|it|us|him|her|them|the|a|some|my|your|money|funds|transfer|\$)/, /\bwire transfer\b/, /\bwestern union\b/, /\bmoney ?gram\b/, /\b(bank|international) transfer\b/]],
  ['CRYPTO', [/\b(bitcoin|btc|ethereum|usdt|tether|crypto(currency)?|coinbase|binance|dogecoin)\b/, /\bwallet address\b/]],
  ['URGENCY', [/\brn\b/, /\b(urgent(ly)?|asap|immediately|hurry|emergency|right away|right now|quickly)\b/, /\bneed(s|ed)? (it|this|that|the money|money|cash)? ?(today|tonight|now)\b/, /\bin the next \d+ (min|mins|minutes|hour|hours)\b/]],
  ['SECRECY', [/\bdelete (this|these|the) (message|messages|text|texts|chat)\b/, /\b(don'?t|do not) (tell|mention|say (anything|a word)|let (anyone|anybody|mom|dad|him|her|them))/, /\bkeep (this|it|that) (a )?(secret|quiet|private|between us)/, /\bbetween (us|you and me)\b/, /\bno ?one (can|needs to|should) know\b/]],
  ['NEW_NUMBER', [/\b(new|different) (phone )?number\b/, /\bnew phone\b/, /\bchanged my (phone )?number\b/, /\blost my phone\b/, /\b(my )?phone (broke|died|is broken)\b/, /\b(friend'?s|borrowed) phone\b/]],
  ['PAYBACK_PROMISE', [/\b(pay|paying|paid|repay|send|give|get) (you|it|that|this|the money) back\b/, /\b(venmo|zelle|cash ?app|paypal) (you|it) back\b/, /\brepay(ing)? you\b/, /\b(double|triple) (it|your money)\b/]],
];

/**
 * Does the text ask for money, whatever the story is? This is what catches scams nobody planned for:
 * a request for money from a voice or number you can't verify is the thing to check, not the excuse.
 * @param {string} text
 * @returns {boolean}
 */
export function asksForMoney(text) {
  const t = norm(text);
  const verb = '(?:need|needs|send|sent|give|lend|loan|borrow|wire|transfer|pay|buy|cover|venmo|zelle|paypal|cash ?app|get me|help me with)';
  const money = '(?:\\bmoney\\b|\\bcash\\b|\\bdollars?\\b|\\bbucks\\b|\\bfunds\\b|\\bpayment\\b|\\bfees?\\b|\\bbail\\b|\\bdeposit\\b|\\bcards?\\b|\\$\\s?\\d)';
  return new RegExp(`\\b${verb}\\b[^.?!\\n]{0,60}${money}`).test(t)
    || /\$\s?\d[\d,]*(\.\d{1,2})?[^.?!\n]{0,40}\b(need|please|asap|today|now|right away)\b/.test(t)
    || /\b\d[\d,]*\s?(dollars?|bucks|usd)\b/.test(t);
}

/**
 * Quick read of a message: warning tags, the amount (in dollars, as text), the likely payment method, whether it asks for money.
 * @param {string} text
 * @returns {{tags: string[], amount: string, method: string|null, ask: boolean}}
 */
export function suggest(text) {
  const t = norm(text);
  const tags = RULES.filter(([, res]) => res.some((re) => re.test(t))).map(([tag]) => tag);
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(t) || /(\d{1,6})\s*(?:dollars|bucks|usd)/.exec(t);
  let amount = '';
  if (m) amount = m[1].replace(/,/g, '') + (m[2] !== undefined ? `.${m[2]}` : '');
  let method = null;
  if (tags.includes('GIFT_CARD')) method = 'gift_card';
  else if (tags.includes('WIRE')) method = 'wire';
  else if (tags.includes('CRYPTO')) method = 'crypto';
  else if (/venmo|zelle|cash\s?app/.test(t)) method = 'venmo_cashapp_zelle';
  return { tags, amount, method, ask: asksForMoney(t) };
}

/**
 * Worth interrupting someone for: a risky payment method, or two or more warning signs together.
 * @param {string[]} tags
 */
export const riskyEnough = (tags) => tags.some((x) => ['GIFT_CARD', 'WIRE', 'CRYPTO'].includes(x)) || tags.length >= 2;

/**
 * How alarming is a stretch of speech from a call? 0 = nothing, 1 = someone is asking for money (verify who it is),
 * 2 = asking for money with scam warning signs (stop).
 * @param {string} text
 * @returns {{level: 0|1|2, tags: string[], amount: string, ask: boolean}}
 */
export function callRisk(text) {
  const s = suggest(text);
  const level = riskyEnough(s.tags) && (s.ask || s.tags.some((x) => ['GIFT_CARD', 'WIRE', 'CRYPTO'].includes(x))) ? 2 : (s.ask ? 1 : 0);
  return { level, tags: s.tags, amount: s.amount, ask: s.ask };
}
