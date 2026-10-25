// Instant scam hints, on the phone (and in the message bot). Pure: no DOM, no network, runs in browsers and Node.
// These only WARN and pre-fill forms. They never clear anything: only the friend's signed answer can make a request green.
// The server's risk layer (server/src/risk, rules + Gemini) is the authoritative analysis; this is the fast first look.

export const TAG_LABELS = {
  URGENCY: 'Pressure to act fast', SECRECY: 'Asks you to keep it secret', NEW_NUMBER: 'New number',
  GIFT_CARD: 'Gift cards', WIRE: 'Wire transfer', CRYPTO: 'Crypto', PAYBACK_PROMISE: 'Promises to pay back',
  FIRST_REQUEST: "First time they've asked",
};

const norm = (text) => String(text ?? '').slice(0, 5000).toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const EMERGENCY_STORY = /\b(arrested|in jail|bail|hospital|car accident|stranded|kidnapp?ed|ransom|warrant|lawyer)\b/;
const ASKS_FOR_MONEY = /\$\s?\d|\b\d[\d,]*\s?(dollars?|bucks|usd)\b|\b(send|wire|venmo|zelle|cash ?app|paypal|transfer|pay|buy|need)\b[^.?!\n]{0,60}\b(money|cash|funds|bail|ransom|fine|fee|cards?|rent|payment)\b/;

const RULES = [
  ['GIFT_CARD', [/gift ?cards?/, /\b(itunes|google play|steam|amazon|target|apple|walmart|ebay) (gift )?(cards?|codes?)\b/, /\bitunes\b/]],
  ['WIRE', [/\b(by|via|through|over) (a )?wire\b/, /\bwire (me|it|us|him|her|them|the|a|some|my|your|money|funds|transfer|\$)/, /\bwire transfer\b/, /\bwestern union\b/, /\bmoney ?gram\b/, /\b(bank|international) transfer\b/]],
  ['CRYPTO', [/\b(bitcoin|btc|ethereum|usdt|tether|crypto(currency)?|coinbase|binance|dogecoin)\b/, /\bwallet address\b/]],
  ['URGENCY', [/\b(act now|call now|final notice|last chance|within (24|48) hours|before (midnight|tonight|the deadline))\b/, /\b(account|card) (will be|has been|is|was) (locked|suspended|frozen|closed|blocked)\b/, /\b(fraud alert|suspicious (charge|activity|transaction)|unauthorized (purchase|charge|transaction))\b/, /\btime[- ]sensitive\b/, /\brn\b/, /\b(urgent(ly)?|asap|immediately|hurry|emergency|right away|right now|quickly)\b/, /\bneed(s|ed)? (it|this|that|the money|money|cash)? ?(today|tonight|now)\b/, /\bin the next \d+ (min|mins|minutes|hour|hours)\b/]],
  ['SECRECY', [/\b(don'?t|do not) (call|contact|involve|text) (dad|mom|anyone|anybody|the police|police|the bank)\b/, /\bdiscreet(ly)?\b/, /\bdelete (this|these|the) (message|messages|text|texts|chat)\b/, /\b(don'?t|do not) (tell|mention|say (anything|a word)|let (anyone|anybody|mom|dad|him|her|them))/, /\bkeep (this|it|that) (a )?(secret|quiet|private|between us)/, /\bbetween (us|you and me)\b/, /\bno ?one (can|needs to|should) know\b/]],
  ['NEW_NUMBER', [/\b(from|on|using) (my |a )?(friend|sister|brother|mom|dad|mother|father|cousin|aunt|uncle|someone|stranger)'?s? phone\b/, /\b(new|different) (phone )?number\b/, /\bnew phone\b/, /\bchanged my (phone )?number\b/, /\blost my phone\b/, /\b(my )?phone (broke|died|is broken)\b/, /\b(friend'?s|borrowed) phone\b/]],
  ['PAYBACK_PROMISE', [/\b(we|i)('ll| will) (reimburse|refund)\b/, /\b(pay|paying|paid|repay|send|give|get) (you|it|that|this|the money) back\b/, /\b(venmo|zelle|cash ?app|paypal) (you|it) back\b/, /\brepay(ing)? you\b/, /\b(double|triple) (it|your money)\b/]],
];

// Impostors of an institution (bank, tax office, tech support, police) can't be paired like a friend, so the defence is
// different: hang up and call the number you already trust. These phrases only choose which advice to show.
const INSTITUTION = [
  /\b(irs|internal revenue|back taxes|tax (debt|lien))\b/, /\bsocial security\b/, /\bmedicare\b/,
  /\b(bank|card|account|security|fraud) (fraud |security )?(department|team|alert|specialist|agent)\b/, /\bfraud (department|team|alert)\b/,
  /\b(microsoft|apple|windows|amazon) (tech )?support\b/, /\btech support\b/, /\bgeek squad\b/, /\b(your )?computer (has|is) (a )?(virus|infected|hacked)\b/,
  /\b(arrest warrant|warrant for your arrest|you will be arrested|court (date|order|fine))\b/, /\b(police|sheriff|detective|officer) (department|here|calling)\b/,
  /\bverify your (account|identity|social)\b/, /\bsuspended (account|card)\b/, /\bunpaid (toll|fine|ticket)s?\b/,
];

/**
 * Is someone claiming to be an institution (bank, government, tech support, police)?
 * @param {string} text
 * @returns {boolean}
 */
export function claimsInstitution(text) {
  const t = norm(text);
  return INSTITUTION.some((re) => re.test(t));
}

/**
 * Does the text ask for money, whatever the story is? This is what catches scams nobody planned for:
 * a request for money from a voice or number you can't verify is the thing to check, not the excuse.
 * @param {string} text
 * @returns {boolean}
 */
export function asksForMoney(text) {
  const t = norm(text);
  return new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,60}${MONEY}`).test(t)
    || new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,40}${SPELLED}`).test(t)
    || bareFigure(t) !== ''
    || /\$\s?\d[\d,]*(\.\d{1,2})?[^.?!\n]{0,40}\b(need|please|asap|today|now|right away)\b/.test(t)
    || /\b\d[\d,]*\s?(dollars?|bucks|usd)\b/.test(t);
}

// Words that ask for money, what counts as a money word, and how amounts are spoken ("1k", "a thousand", "five hundred").
const VERB = '(?:need|needs|send|sent|give|lend|loan|borrow|wire|transfer|pay|buy|cover|venmo|zelle|paypal|cash ?app|get me|help me with|help me out with|spot me|front me|hook me up with|chip in)';
const MONEY = '(?:\\bmoney\\b|\\bcash\\b|\\bdollars?\\b|\\bbucks\\b|\\bgrand\\b|\\bfunds\\b|\\bpayment\\b|\\bfees?\\b|\\bbail\\b|\\bdeposit\\b|\\bcards?\\b|\\$\\s?\\d)';
const SPELLED = '(?:\\b\\d+(?:\\.\\d+)?\\s?k\\b|\\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty)\\s+(?:hundred|thousand|grand)\\b|\\ba\\s+(?:grand|thousand|hundred)\\b)';
const NOT_MONEY_BEFORE = new Set(['at', 'by', 'around', 'before', 'after', 'until', 'till', 'about', 'near', 'in', 'of', 'from', 'room', 'flight', 'gate', 'number', 'no', 'apt', 'unit', 'page', 'exit', 'channel', 'track']);
const MONEYISH_AFTER = new Set(['dollars', 'bucks', 'usd', 'cash', 'euros', 'pounds']);

// A bare number (1000, 2,500) right after a word that asks ("send me 1000"), skipping times, years of things, percentages and
// counts of things ("2024 photos", "530", "100%"). Done in code, not regex lookbehinds, so older iPhones can run it.
function bareFigure(t) {
  const re = new RegExp(`\\b${VERB}\\b([^.?!\\n]{0,40})`, 'g');
  let m;
  while ((m = re.exec(t))) {
    const tail = m[1];
    for (const n of tail.matchAll(/\b\d[\d,]{2,}\b/g)) {
      const before = tail.slice(0, n.index).trim().split(/\s+/).pop() || '';
      const rest = tail.slice(n.index + n[0].length);
      const after = (rest.match(/^\s*([a-z]+)/) || [])[1] || '';
      if (/^\s?%/.test(rest) || /^:/.test(rest) || NOT_MONEY_BEFORE.has(before)) continue; // a percentage, a clock time, "at 530"
      if (after.length > 3 && after.endsWith('s') && !MONEYISH_AFTER.has(after)) continue; // "2024 photos", "1000 words"
      return n[0].replace(/,/g, '');
    }
  }
  return '';
}

const WORD_NUM = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50 };
const WORD_UNIT = { hundred: 100, thousand: 1000, grand: 1000 };

// The amount in dollars, as text, however it was written: $60, 60 dollars, 1k, 1,000, a thousand dollars, two hundred, or a bare
// number right after a word that asks ("send me 1000"). Empty when there is none; it never guesses from a lone number.
function amountFrom(t) {
  let m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(t) || /(\d{1,6})\s*(?:dollars|bucks|usd)/.exec(t);
  if (m) return m[1].replace(/,/g, '') + (m[2] !== undefined ? `.${m[2]}` : '');
  m = /\b(\d+(?:\.\d+)?)\s?k\b/.exec(t);
  if (m) return String(Math.round(parseFloat(m[1]) * 1000));
  m = /\b(a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty)\s+(hundred|thousand|grand)\b/.exec(t);
  if (m) return String(WORD_NUM[m[1]] * WORD_UNIT[m[2]]);
  m = /\ba\s+(grand|thousand|hundred)\b/.exec(t);
  if (m) return String(WORD_UNIT[m[1]]);
  return bareFigure(t);
}
/**
 * Quick read of a message: warning tags, the amount (in dollars, as text), the likely payment method, whether it asks for money.
 * @param {string} text
 * @returns {{tags: string[], amount: string, method: string|null, ask: boolean}}
 */
export function suggest(text) {
  const t = norm(text);
  const tags = RULES.filter(([, res]) => res.some((re) => re.test(t))).map(([tag]) => tag);
  // An emergency story only counts as pressure when it comes with a request for money (the same rule the server uses).
  if (!tags.includes('URGENCY') && EMERGENCY_STORY.test(t) && ASKS_FOR_MONEY.test(t)) tags.push('URGENCY');
  const amount = amountFrom(t);
  let method = null;
  if (tags.includes('GIFT_CARD')) method = 'gift_card';
  else if (tags.includes('WIRE')) method = 'wire';
  else if (tags.includes('CRYPTO')) method = 'crypto';
  else if (/venmo|zelle|cash\s?app/.test(t)) method = 'venmo_cashapp_zelle';
  return { tags, amount, method, ask: asksForMoney(t), institution: claimsInstitution(t) };
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
  const payTag = s.tags.some((x) => ['GIFT_CARD', 'WIRE', 'CRYPTO'].includes(x));
  // An "institution" asking for money is a scam signal on its own: real ones don't phone you for gift cards or transfers.
  const level = (riskyEnough(s.tags) && (s.ask || payTag)) || (s.institution && (s.ask || payTag)) ? 2 : (s.ask ? 1 : 0);
  return { level, tags: s.tags, amount: s.amount, ask: s.ask, institution: s.institution };
}

const has = (tags, ...names) => names.some((n) => tags.includes(n));
const GUIDE = [
  { id: 'institution', when: (s) => s.institution,
    title: 'Someone pretending to be a bank, agency or company',
    why: 'Banks, tax offices, tech support and police do not ask for gift cards, crypto, transfers or codes by call or text.',
    steps: ['Do not reply, click a link or call back a number in the message.', 'Hang up. Call the number on your card, your bill or their official website.', 'Never read out a code that was sent to your phone.'] },
  { id: 'family', when: (s, t) => has(s.tags, 'NEW_NUMBER') && (has(s.tags, 'URGENCY', 'SECRECY') || s.ask) || /\b(grandma|grandpa|nana|papa|mom|dad)\b/.test(t) && has(s.tags, 'NEW_NUMBER'),
    title: 'Possible family-emergency scam',
    why: 'Scammers pose as a relative in trouble on a new number, often with a cloned voice.',
    steps: ['Stop. Do not send money yet.', 'Call your family member on the number you already have.', 'Ask for your Vouch code word, or check with their phone in Vouch.'] },
  { id: 'giftcard', when: (s) => has(s.tags, 'GIFT_CARD'),
    title: 'Gift-card demand',
    why: 'Only scammers ask to be paid in gift cards. Once the codes are read out, the money is gone.',
    steps: ['Do not buy gift cards or read out any codes.', 'Check who it really is with their own phone in Vouch.', 'If you already sent codes, call the card company right now.'] },
  { id: 'wire', when: (s) => has(s.tags, 'WIRE'),
    title: 'Wire or bank-transfer demand',
    why: 'Transfers are hard to undo, which is why scammers ask for them.',
    steps: ['Do not send a transfer from a message or call.', 'Confirm with the person on a number you already have.', 'If you already sent one, call your bank immediately and ask for a recall.'] },
  { id: 'crypto', when: (s, t) => has(s.tags, 'CRYPTO') || /\b(guaranteed returns?|trading platform|double your (money|investment)|investment opportunity)\b/.test(t),
    title: 'Crypto or "investment" pressure',
    why: 'Fake investments and crypto payments are almost impossible to get back.',
    steps: ['Do not send crypto or move money to a new platform.', 'Real investments never guarantee returns or rush you.', 'Talk to someone you trust before doing anything.'] },
  { id: 'romance', when: (s, t) => s.ask && /\b(i love you|my darling|sweetheart|never met|oil rig|deployed|military|widow|overseas)\b/.test(t),
    title: 'Possible romance scam',
    why: 'Someone you have not met in person is asking for money.',
    steps: ['Do not send money to someone you have never met.', 'Ask a family member what they think.', 'Be wary if they refuse a live video call.'] },
  { id: 'prize', when: (s, t) => /\b(you (have )?won|winner|lottery|sweepstakes|claim your prize|processing fee to (claim|release))\b/.test(t),
    title: 'Prize or lottery scam',
    why: 'Real prizes never ask you to pay a fee first.',
    steps: ['Do not pay anything to claim a prize.', 'Do not share bank details or codes.', 'Delete the message.'] },
  { id: 'invoice', when: (s, t) => /\b(new account|updated (bank|payment) details|changed (our )?(bank|account)|wire the (deposit|payment))\b/.test(t),
    title: 'Changed payment details',
    why: 'Scammers copy a real bill or landlord and swap in their own account.',
    steps: ['Do not pay to a new account from a message.', 'Call the company or person on a number you already have.', 'Check the account details in person or on the original bill.'] },
  { id: 'overpay', when: (s, t) => /\b(overpaid|send back the difference|check (has )?cleared|mystery shopper)\b/.test(t),
    title: 'Overpayment scam',
    why: 'A fake check is "accidentally" too large and you are asked to send the difference back.',
    steps: ['Do not send any money back.', 'A check can bounce days after the bank shows it.', 'Tell your bank.'] },
  { id: 'pressure', when: (s) => s.ask && has(s.tags, 'URGENCY', 'SECRECY', 'PAYBACK_PROMISE'),
    title: 'Money request with pressure',
    why: 'Rushing you and keeping it secret are how scams stop you from checking.',
    steps: ['Slow down. Nothing real needs money in the next five minutes.', 'Check who it is with their own phone in Vouch.', 'Do not keep it secret: tell someone you trust.'] },
  { id: 'ask', when: (s) => s.ask,
    title: 'Someone is asking you for money',
    why: 'A message can come from a hacked account or a cloned voice, even when it looks like your friend.',
    steps: ["Don't send anything yet.", 'Check with their own phone in Vouch. It takes one tap.', 'Or call them on a number you already know.'] },
];

/**
 * Names the kind of scam in plain words and says what to do, from the language of a message or a stretch of a call.
 * Returns null when nothing stands out. It only guides; it never clears anything.
 * @param {string} text
 * @returns {{id: string, title: string, why: string, steps: string[]}|null}
 */
export function classify(text) {
  const t = norm(text);
  if (!t) return null;
  const s = suggest(t);
  const g = GUIDE.find((x) => x.when(s, t));
  return g ? { id: g.id, title: g.title, why: g.why, steps: g.steps } : null;
}

/**
 * Splits text into plain and risky pieces, so a live caption can mark the words that raised the alarm
 * (gift cards, "don't tell", amounts, a new number, a bank claiming something...). Display only.
 * @param {string} text
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function highlight(text) {
  const t = String(text ?? '').slice(0, 5000);
  const lower = t.toLowerCase().replace(/[‘’ʼ]/g, "'"); // same length as t, so positions line up
  const ranges = [];
  const add = (re) => { const g = new RegExp(re.source, 'g'); let m; while ((m = g.exec(lower)) && m[0]) { ranges.push([m.index, m.index + m[0].length]); if (g.lastIndex === m.index) g.lastIndex++; } };
  for (const [, res] of RULES) res.forEach(add);
  INSTITUTION.forEach(add);
  add(/\$\s?\d[\d,]*(\.\d{1,2})?/); add(/\b\d[\d,]*\s?(dollars?|bucks|usd)\b/);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  const out = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: t.slice(at, a), hit: false });
    out.push({ text: t.slice(a, b), hit: true });
    at = b;
  }
  if (at < t.length) out.push({ text: t.slice(at), hit: false });
  return out;
}
