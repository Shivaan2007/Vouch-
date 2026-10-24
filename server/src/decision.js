import {
  TIER1_MAX, TIER2_MAX, HIGH_RISK_TAG_COUNT,
} from './config.js';

export function tierFor(amount) {
  // Unknown amount is treated as tier 2: never as small money.
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 2;
  if (amount <= TIER1_MAX) return 1;
  if (amount <= TIER2_MAX) return 2;
  return 3;
}

const TAG_WORDS = {
  URGENCY: 'pressure to hurry', SECRECY: 'asks you to keep it secret', NEW_NUMBER: 'a new number',
  GIFT_CARD: 'gift cards', WIRE: 'a wire transfer', CRYPTO: 'crypto',
  PAYBACK_PROMISE: 'a promise to pay you back', FIRST_REQUEST: 'first time asking',
};

// Pure function. No database, no AI text in, no AI text out. Rules run top to bottom, first match wins.
// Tags can add reasons but can never move a verdict toward green.
export function decide({
  answer = 'none', tags = [], paymentRisk = 'low', amount = null,
  wordOk = false, secondConfirms = 0, secondNo = false, timedOut = false,
} = {}) {
  const tier = tierFor(amount);
  const needs = { word: tier >= 2, second: tier === 3 };
  const tagNote = tags.length >= HIGH_RISK_TAG_COUNT
    ? `${tags.length} warning signs: ${tags.map((t) => TAG_WORDS[t] || t.toLowerCase()).join(', ')}.`
    : null;
  const out = (verdict, reasons) => ({ verdict, reasons: tagNote ? [...reasons, tagNote] : reasons, tier, needs });

  if (secondNo) return out('red', ['A second circle member said this does not sound like them.']);
  if (answer === 'not_me') return out('red', ['Your friend says they did NOT send this request.']);
  if (answer !== 'yes') {
    return timedOut
      ? out('amber', ['No answer in 2 minutes. Wait. Do not send money until your friend answers.'])
      : out('amber', ['Waiting for your friend to answer.']);
  }
  if (timedOut) return out('amber', ['Wait. This request timed out.']);

  // answer === 'yes' from here
  const reasons = [];
  let green = true;
  if (paymentRisk === 'high') {
    green = false;
    reasons.push('Gift cards, wires and crypto are how scammers get paid and are hard to undo. Wait, even with a Yes.');
  }
  if (needs.word && !wordOk) {
    green = false;
    reasons.push('More money, more proof. Now ask them for your word.');
  }
  if (needs.second && secondConfirms < 1) {
    green = false;
    reasons.push('Large amount. Waiting for a second circle member to confirm.');
  }
  if (green) {
    reasons.unshift('Your friend confirmed with a signature that checks out.');
    if (needs.word) reasons.push('The secret word matched.');
    if (needs.second) reasons.push('A second circle member confirmed.');
  }
  return out(green ? 'green' : 'amber', reasons);
}
