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

// Scams that are NOT about sending money: they want a code, a password, remote access, your ID or a click. The friend check
// is for money requests, so these get the warning and the plain-words guide only. Conservative on purpose, so everyday
// messages ("what's the wifi pin?", "click the link to join the call") do not trigger a full-screen alert.
const NOT_A_REQUEST = /\b(do not|don't|never|won't|will never) (ever )?(share|give|tell|read|send|ask)\b/;
const CODE_ASK = /\b(read|tell|give|send|share|forward|repeat)\b[^.?!]{0,45}\b(code|otp|passcode|pin)\b|\b(code|otp|passcode|pin)\b[\s\S]{0,80}?\b(read|tell|give|send|share|forward|repeat)\b\s+(it\s+)?(back\s+)?(to\s+)?(me|us|them)\b/;
const CODE_CONTEXT = /\b(sent|texted|text message|sms|verification|security code|one[- ]time|authentication|6[- ]digit|six[- ]digit|2fa|bank|account)\b/;
const REMOTE = /\b(anydesk|teamviewer|ultraviewer|quick ?support|remote (access|desktop|control|session)|control (of )?your (computer|pc|phone|screen))\b/;
const PASSWORD_ASK = /\b(confirm|verify|enter|update|reset|re-?enter)\b[^.?!]{0,30}\byour\b[^.?!]{0,20}\b(password|passcode|login details|log-?in details|credentials|card (number|details)|cvv|security answers?)\b/;
const ID_WORD = /\b(ssn|social security( number)?|passport|driver'?s? licen[cs]e|national id|date of birth|dob|bank statement)\b/;
const ID_ASK = /\b(send|share|confirm|verify|provide|give|need|upload|photo of|picture of)\b/;
const ID_CONTEXT = /\b(job|hr|payroll|benefits|suspended|application|loan|refund|government|agency|office|verify|verification|payment)\b/;
const HAS_LINK = /\b(https?:\/\/|www\.)\S+|\b[a-z0-9]+(?:-[a-z0-9]+)+\.(?:com|net|org|co|info|biz)\b\/?\S*|\b[a-z0-9-]+\.(top|xyz|click|icu|cyou|cfd|zip|link|live|support|help)\b\/?\S*|\b(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rb\.gy|ow\.ly)\/\S+/;
const LINK_BAIT = /\b(account|suspended|locked|on hold|verify|confirm|billing|payment (failed|declined)|parcel|package|delivery|redeliver|refund|unusual (activity|sign-?in)|security alert|expired|prize|winner|you (have )?won|is this you|in this video)\b/;

/**
 * Which kind of non-money scam a message looks like: 'code', 'remote', 'password', 'identity', 'phish', or '' for none.
 * @param {string} text
 * @returns {'code'|'remote'|'password'|'identity'|'phish'|''}
 */
export function dangerKind(text) {
  const t = norm(text);
  if (!t) return '';
  const warning = NOT_A_REQUEST.test(t); // a real company saying "never share this code" is not asking for it
  if (!warning && CODE_ASK.test(t) && CODE_CONTEXT.test(t)) return 'code';
  if (REMOTE.test(t)) return 'remote';
  if (!warning && PASSWORD_ASK.test(t)) return 'password';
  if (ID_WORD.test(t) && ID_ASK.test(t) && (ID_CONTEXT.test(t) || claimsInstitution(t))) return 'identity';
  if (HAS_LINK.test(t) && LINK_BAIT.test(t)) return 'phish';
  return '';
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
  const kind = dangerKind(t);
  return { tags, amount, method, ask: asksForMoney(t), institution: claimsInstitution(t), kind, danger: !!kind };
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
  const level = (riskyEnough(s.tags) && (s.ask || payTag)) || (s.institution && (s.ask || payTag)) || s.danger ? 2 : (s.ask ? 1 : 0);
  return { level, tags: s.tags, amount: s.amount, ask: s.ask, institution: s.institution };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The call engine. A scam call is not one bad word: it is a SCRIPT that unfolds in stages. First the caller claims to be someone
// (a bank, an agency, a grandchild), then frightens or rushes you, then isolates you ("don't tell anyone", "stay on the line"),
// and only then asks for the thing: a code, card details, remote access, a "safe account", a gift card, cash. This engine listens
// for that shape over time, the way scam-call research and call-protection products describe it, instead of matching one phrase.
//   - signals have weights; recent ones count more (they decay over about a minute), so a long honest call can't add up slowly
//   - stages are remembered for the whole call: a script told slowly is still a script
//   - a few RED LINES are a stop at once: real banks never ask you to read out a code or move your money
//   - a promotion to STOP that rests on soft signals must hold for a moment, so one mis-heard word can't cry wolf
//   - phrases real organisations say ("we will never ask for your PIN") count against, but never cancel a red line
// Pure functions, no DOM, runs fully offline. The AI read can raise the level further; it can never lower this floor.
// ---------------------------------------------------------------------------------------------------------------------------
const HARD = 99;
const CALL_SIGNALS = [
  ['OTP', HARD, [
    /\b(read|tell|give|send|confirm|repeat|share|say)( me| us)?( back)?( the| that| your| this| those)?( (six|6|four|4|five|5)[- ]?digit)? ?(code|otp|passcode|digits)\b/,
    /\bwhat(?:'s| is) the code\b/, /\bcode (we|i) (just )?(sent|texted)\b/, /\bo\.? ?t\.? ?p\b/, /\bone[- ]time (pass)?(code|word)\b/,
    /\b(digits|numbers) (we|i) (just )?(texted|sent)\b/,
    /\b(sent|texted|text) (you )?a (six[- ]digit |6[- ]digit |verification |security )?code\b[^.?!]{0,80}\b(read|tell|give|repeat|confirm|need)\b/,
    /\b(code|digits|passcode)\b[^.?!]{0,60}\b(read|tell|give|say|repeat)\b[^.?!]{0,20}\b(back|to me)\b/,
  ]],
  ['SAFE_ACCOUNT', HARD, [/\b(safe|secure|protected|holding|temporary) account\b/, /\b(move|transfer|withdraw)( all| some| out)?( of)? your (money|savings|funds|balance|account)\b/, /\bprotect your (money|funds|savings)\b/]],
  ['REMOTE_ACCESS', HARD, [
    /\b(anydesk|any desk|teamviewer|team viewer|quick ?support|ultraviewer|logmein|ammyy|remote (access|desktop|control|session))\b/,
    /\b(download|install)\b[^.?!]{0,30}\b(app|software|program)\b[^.?!]{0,50}\b(so (that )?i can|to (see|access|fix|help|control))\b/, /\bshare your screen\b/,
  ]],
  ['CASH_PICKUP', HARD, [/\bcourier\b[^.?!]{0,30}\b(collect|pick ?up|come)\b/, /\bbitcoin atm\b/, /\b(put|place|seal)\b[^.?!]{0,20}\bcash\b[^.?!]{0,20}\b(envelope|box|bag)\b/, /\bpick ?up the (cash|money|envelope)\b/]],
  ['PIN', HARD, [/\b(your|the) (atm |debit |card |banking )?pin( number)?\b/, /\b(online banking|account|login|log ?in) password\b/, /\blog ?in details\b/]],
  ['PAY_METHOD', HARD, [
    /\b(buy|get|purchase|pick up|grab|go (to|and))\b[^.?!]{0,40}\b(gift|gif|apple|google play|itunes|steam|target|amazon) cards?\b/,
    /\bpay (with|using|by|in)( an?)? (apple |google play |itunes |steam |target |amazon |gift )?cards?\b/,
    /\b(send|transfer|deposit)\b[^.?!]{0,30}\b(bitcoin|crypto|btc|usdt)\b/, /\bwire (me|us|the|your)\b/,
  ]],
  ['CREDENTIAL', 3, [
    /\b(ssn|social security number)\b/, /\b(full|entire|whole|long|16[- ]digit|your|the) card number\b/, /\bcvv\b|\bsecurity code on the back\b|\bthree digits on the back\b/,
    /\bmother'?s maiden( name)?\b/, /\bdate of birth\b|\bbirth ?date\b/, /\brouting( and account)? number\b|\b(your|the) account number\b/, /\bexpir(y|ation) date\b/,
  ]],
  ['ISOLATION', 3, [
    /\b(stay|keep me|remain) on the (line|phone)\b/, /\bdo ?n'?t hang up\b|\bdo not hang up\b/, /\bif (the )?(bank|teller|cashier|clerk) (asks|ask)\b/,
    /\bsay (it'?s|it is|that it'?s) (for|a) (a )?(gift|family|renovation|home|car)/, /\bkeep me on speaker\b/,
    /\bdo ?n'?t (tell|let) (anyone|anybody|your (family|wife|husband|son|daughter|kids?))\b/,
  ]],
  ['CALLBACK', 3, [/\bcall (us|me) back (at|on) [\d ()+-]{7,}/, /\bdo ?n'?t call the number (on|from) (your|the) (card|statement|bank)/, /\bthis is the (direct|private|fraud) line\b/]],
  ['AUTHORITY', 2, [
    /\bthis is (officer|agent|detective|sergeant|inspector)\b/, /\bbadge number\b/,
    /\bcalling (you )?from (your |the )?(bank|irs|medicare|microsoft|amazon|apple|social security|police|fbi|sheriff)\b/,
    /\b(it'?s|this is) (me|your) (grand ?(son|daughter|kid|child)|nephew|niece)\b/, /\bgrand(ma|pa|mother|father|dad)?,? it'?s me\b/,
  ]],
  ['FEAR', 2, [
    /\b(account|computer|identity|card|ssn|social security number)( has been| was| is| have been)? (compromised|hacked|stolen|suspended|frozen|breached)\b/,
    /\bwarrant\b/, /\byou will be arrested\b/, /\blose (all )?(of )?your (money|savings)\b/,
  ]],
  // A plain small amount ("lend me 40", "send 25") is a request for money too. The shared rules only count bigger or marked amounts.
  ['ASK', 2, [/\b(lend|loan|borrow|spot|front|send|wire|give|venmo|zelle|cash ?app)( me| us)?( about| around)? \$?\d[\d,]*(\.\d\d)?\b(?! (minutes?|mins?|hours?|days?|seconds?|pm|am|o'clock|years?|times|people|more))/]],
  ['COUNTER', -2, [
    /\bwe(?:'ll| will) never (ask|call|email|text)\b/, /\b(hang up|call us back)[^.?!]{0,30}(back of your card|number on your card|official (number|website))/,
    /\bappointment (reminder|confirmation)\b/, /\bpress \d to (confirm|cancel|stop)\b/, /\bthis is an automated\b/, /\bnever share (this|your) (code|pin|password)\b/,
  ]],
];
const STAGE_OF = { AUTHORITY: 'authority', FEAR: 'fear', ISOLATION: 'isolation', CALLBACK: 'isolation', ASK: 'action', CREDENTIAL: 'action', PAY_METHOD: 'action', OTP: 'action', SAFE_ACCOUNT: 'action', REMOTE_ACCESS: 'action', CASH_PICKUP: 'action', PIN: 'action' };
const CALL_REASON = {
  OTP: 'They asked you to read out a code. Real banks never do this.',
  SAFE_ACCOUNT: 'They want you to move your money to a "safe" account. That is always a scam.',
  REMOTE_ACCESS: 'They want control of your computer or phone.',
  CASH_PICKUP: 'They want to collect cash from you.',
  PIN: 'They asked for a PIN or a password.',
  PAY_METHOD: 'They want to be paid with gift cards, crypto or a wire.',
  CREDENTIAL: 'They asked for personal or card details.',
  ISOLATION: 'They want you to keep quiet or stay on the line.',
  CALLBACK: 'They told you not to use the phone number you already trust.',
  AUTHORITY: 'They claim to be an official, a company, or someone you know.',
  FEAR: 'They are rushing or scaring you.',
  ASK: 'They asked for money.',
};
const CALL_ORDER = ['OTP', 'SAFE_ACCOUNT', 'REMOTE_ACCESS', 'CASH_PICKUP', 'PIN', 'PAY_METHOD', 'CREDENTIAL', 'CALLBACK', 'ISOLATION', 'AUTHORITY', 'FEAR', 'ASK'];

// A negative word just before the phrase ("we will NEVER ask you to read out a code") turns it from a threat into reassurance.
// Only the same sentence counts: "Don't tell mom. A courier will collect the cash." must not cancel the second sentence.
function negated(t, index) {
  // Reach back far enough for a list ("we will never ask for your PIN or your password"), but not across a "but" or a comma-and-ask.
  const sentence = t.slice(Math.max(0, index - 70), index).split(/[.?!;]|\b(?:but|however|except)\b/).pop();
  return /\b(never|don'?t|do not|won'?t|will not|not)\b(?:\W+\w+){0,7}\W*$/.test(sentence);
}

/** A fresh state for one call. */
export function callInit() {
  return { seen: new Set(), hits: [], stages: new Set(), cats: new Set(), level: 0, pendingAt: 0 };
}

/**
 * Feed what has been heard so far (the whole transcript is fine; repeats are recognised and not counted twice).
 * @param {ReturnType<typeof callInit>} state mutated and returned
 * @param {string} text the transcript so far
 * @param {number} [now]
 * @returns {{level: 0|1|2} & ReturnType<typeof callInit>}
 */
export function callStep(state, text, now = Date.now()) {
  const t = norm(text);
  const add = (cat, w, key) => {
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.hits.push({ cat, w, at: now });
    if (w > 0) { state.cats.add(cat); if (STAGE_OF[cat]) state.stages.add(STAGE_OF[cat]); }
  };
  for (const [cat, w, patterns] of CALL_SIGNALS) {
    for (const re of patterns) {
      for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
        if (cat !== 'COUNTER' && negated(t, m.index)) continue;
        add(cat, w, `${cat}|${t.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12)}`);
      }
    }
  }
  // Signals the shared phone rules already know how to hear (kept in step with the server's rules).
  const recent = t.slice(-400);
  const s = suggest(recent);
  if (s.tags.includes('URGENCY')) add('FEAR', 2, 'FEAR|tag-urgency');
  if (s.tags.includes('SECRECY')) add('ISOLATION', 3, 'ISOLATION|tag-secrecy');
  if (s.tags.some((x) => ['GIFT_CARD', 'WIRE', 'CRYPTO'].includes(x))) add('PAY_METHOD', 3, 'PAY_METHOD|tag-method');
  if (claimsInstitution(recent)) add('AUTHORITY', 2, 'AUTHORITY|institution');
  if (s.ask) add('ASK', 2, `ASK|${Math.floor(now / 90000)}`);

  // Score: recent signals count fully, older ones fade, and anything past 90 seconds no longer adds.
  let score = 0;
  for (const h of state.hits) if (h.w !== HARD && now - h.at <= 90000) score += h.w * Math.exp(-(now - h.at) / 60000);
  score = Math.max(0, score);
  const hard = state.hits.some((h) => h.w === HARD);
  const c = state.cats;
  const soft2 = score >= 7 || (state.stages.size >= 3 && state.stages.has('action'))
    || (c.has('AUTHORITY') && c.has('CREDENTIAL') && (c.has('FEAR') || c.has('ISOLATION') || c.has('CALLBACK')));
  let level = 0;
  if (hard) level = 2;
  else if (soft2) {
    // Soft signals alone must hold for a moment before they become a STOP (speech-to-text mishears a word now and then).
    if (!state.pendingAt) state.pendingAt = now;
    level = now - state.pendingAt >= 1500 ? 2 : Math.max(state.level, 1);
  } else {
    state.pendingAt = 0;
    if (score >= 3 || c.has('ASK') || c.has('CREDENTIAL') || c.has('PAY_METHOD')) level = 1;
  }
  state.level = Math.max(state.level, level); // a warning is never taken back during a call
  state.score = Math.round(score * 10) / 10;
  return state;
}

/** What to show a person: the four stages as a ladder, the top reasons in plain words, and one thing to do. */
export function callWhy(state) {
  const st = state || callInit();
  const seen = new Set(st.hits.filter((h) => h.w > 0).map((h) => h.cat));
  const reasons = CALL_ORDER.filter((cat) => seen.has(cat)).slice(0, 3).map((cat) => CALL_REASON[cat]);
  return {
    steps: [
      { id: 'authority', on: st.stages.has('authority'), text: "Says they're from a bank, agency or family" },
      { id: 'fear', on: st.stages.has('fear'), text: 'Rushing or scaring you' },
      { id: 'isolation', on: st.stages.has('isolation'), text: 'Asking you to keep quiet or stay on the line' },
      { id: 'action', on: st.stages.has('action'), text: 'Asking for a code, card details or money' },
    ],
    reasons,
    action: st.level >= 2 ? 'Hang up. Then call the number on your card or the official website yourself.' : st.level === 1 ? 'Be careful. Do not give any codes or money. Make sure it is really them.' : '',
  };
}

/**
 * The assistant on a live call: one thing to say next, in plain words, chosen from what has been heard so far. It never decides
 * anything for the person; it suggests the safest next sentence. A rule-based coach, so it works offline and never invents advice.
 * @param {ReturnType<typeof callInit>} state
 * @param {{wordHeard?: boolean, haveFriend?: boolean}} [ctx] wordHeard: the caller said the current code word; haveFriend: there is someone to ask for a word
 * @returns {{kind: 'good'|'stop'|'ask'|'', text: string}}
 */
export function callCoach(state, ctx = {}) {
  const st = state || callInit();
  const c = st.cats;
  if (ctx.wordHeard) return { kind: 'good', text: 'They said our code word, and it matches. Tap "It matches" if you are sure it is really them.' };
  if (!c.size && st.level < 1) return { kind: '', text: '' };
  if (c.has('OTP')) return { kind: 'stop', text: 'Do not read out any code. Say: "I\'ll call you back on the number on my card." Then hang up.' };
  if (c.has('SAFE_ACCOUNT') || c.has('REMOTE_ACCESS') || c.has('CASH_PICKUP') || c.has('PIN') || c.has('PAY_METHOD')) {
    return { kind: 'stop', text: 'Do not do what they ask. Say: "I\'m going to hang up and call you back myself." Then hang up.' };
  }
  if (c.has('CREDENTIAL')) return { kind: 'stop', text: 'Do not give personal or card details. Say: "I\'ll call the bank on the number on my card."' };
  if (st.level >= 1 && ctx.haveFriend) return { kind: 'ask', text: 'Ask them: "What\'s our word?" Do not say it first. If they cannot say it, it is not them.' };
  if (st.level >= 1) return { kind: 'ask', text: 'Ask who they are, and say you will call them back on a number you already have.' };
  return { kind: '', text: '' };
}

const has = (tags, ...names) => names.some((n) => tags.includes(n));
const GUIDE = [
  { id: 'code', when: (s) => s.kind === 'code',
    title: 'Asking for a code',
    why: 'A code sent to your phone is the key to your account. Real banks and companies never ask you to read it out.',
    steps: ['Do not read out or type the code anywhere.', 'Hang up or stop replying.', 'Call the company on the number on your card or its official website.'] },
  { id: 'remote', when: (s) => s.kind === 'remote',
    title: 'Asking for remote access',
    why: 'Letting someone control your device lets them see everything and move your money.',
    steps: ['Do not install anything or give anyone a code or ID.', 'Hang up or close the message.', 'If you already did, switch off the internet on that device and call your bank.'] },
  { id: 'password', when: (s) => s.kind === 'password',
    title: 'Asking for a password or card details',
    why: 'Real companies never ask you to confirm a password or card number from a message.',
    steps: ['Do not enter your password or card details.', 'Do not tap any link in the message.', 'Open the official app or website yourself to check.'] },
  { id: 'identity', when: (s) => s.kind === 'identity',
    title: 'Asking for ID or personal details',
    why: 'Photos and numbers of your ID are used to open accounts in your name.',
    steps: ['Do not send a photo or number of your ID.', 'Look up the real company or office yourself and ask there.', 'Only share ID with someone you contacted first.'] },
  { id: 'phish', when: (s) => s.kind === 'phish',
    title: 'Suspicious link',
    why: 'Fake links copy real sites to steal logins and cards.',
    steps: ['Do not tap the link.', 'Go to the official app or website yourself.', 'If it came from a friend, tell them: their account may be hacked.'] },
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
  [CODE_ASK, REMOTE, PASSWORD_ASK, HAS_LINK].forEach(add);
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
