// The channel-neutral engine behind every Vouch Watch door (Telegram, SMS/WhatsApp via Twilio, the app itself).
// Text (and optionally a screenshot and the earlier messages from the same sender) in; a level and a plain-words read out.
//
//   quick()  the instant read: on-phone rules only, no network. It answers in a blink and is the floor when there is no AI.
//   assess() the full read: the AI INFERS what the message is (money? how much? what kind of scam? who is it pretending to be?
//            what raised concern? what to do?). The rules still run, and the final level is the higher of the two:
//            the AI can raise a warning and never lowers one. It only WARNS; it never calls anything safe.
import { analyzeSafe } from '../server/src/analyze.js';
import { suggest, riskyEnough, classify, TAG_LABELS, callInit, callStep } from '../web/js/lib/scan.js';
import { inferScam } from './infer.js';
import { extractLinks, linkFloor } from './links.js';

export const label = (tags) => tags.map((t) => (TAG_LABELS[t] || t).toLowerCase()).join(', ');

// The offline floor for "is this person just talking to the bot?" (the AI decides this properly when it is available).
const GREETING = /^\s*(yo+|hi+|hey+|hello+|hiya|sup|howdy|good (morning|afternoon|evening)|gm|thanks?( you)?|thx|ok(ay)?|test(ing)?|ping|start|help)\s*[!.?]*\s*$/i;
const ABOUT_BOT = /\b(what|how|who|why)\b[^.?!]*\b(you|this|vouch|bot|work|works|do|does)\b/i;
const looksLikeChat = (text, local) => GREETING.test(text) || (ABOUT_BOT.test(text) && !local.ask && !local.tags.length && String(text).length < 90);
export const INTRO_REPLY = "Hey! I'm Vouch Alert. Forward me a message that asks for money, or paste one here, and I'll tell you what it looks like, who it might be pretending to be, and what to do. Connect me in the Vouch app (My people, Connected apps) and I'll flash a warning there too.";

/** What the AI's judgement means as a level: 0 nothing, 1 asks for money or something is off, 2 stop. */
export function aiLevel(ai) {
  if (!ai) return 0;
  let level;
  if (ai.risk === 'high') level = 2;
  else if (ai.risk === 'medium') level = ai.moneyRequest ? 2 : 1;
  else level = ai.moneyRequest || (ai.risk === 'low' && ai.signals.length) ? 1 : 0;
  // A link or a picture the AI judges to be deceptive counts on its own, even when the words sound harmless.
  const links = (ai.links || []).map((l) => l.risk);
  if (links.includes('high')) level = 2; else if (links.includes('medium')) level = Math.max(level, 1);
  if (ai.image) { if (ai.image.risk === 'high') level = 2; else if (ai.image.risk === 'medium') level = Math.max(level, 1); }
  return level;
}

/**
 * Remembers the last few messages per chat and sender, in memory only, so the AI can read a scam as it unfolds
 * ("I'm stuck", then "need money", then "don't tell mom"). Nothing is written to disk and it forgets after a while.
 */
export function createContext({ keep = 5, ttlMs = 15 * 60 * 1000 } = {}) {
  const m = new Map();
  return {
    get(key) { const r = (m.get(key) || []).filter((x) => Date.now() - x.t < ttlMs); return r.map((x) => x.text); },
    add(key, text) {
      if (!text || !text.trim()) return;
      const r = (m.get(key) || []).filter((x) => Date.now() - x.t < ttlMs);
      r.push({ t: Date.now(), text: String(text).slice(0, 400) });
      m.set(key, r.slice(-keep));
      if (m.size > 2000) m.delete(m.keys().next().value);
    },
  };
}

/**
 * @param {{analyze?: Function, infer?: Function, vouchUrl?: string}} [opts]
 */
export function createCore({ analyze = analyzeSafe, infer = inferScam, vouchUrl = '' } = {}) {
  const levelOf = (tags, risk, local) => (riskyEnough(tags) || risk === 'high' || (local.institution && local.ask) || local.danger ? 2 : (local.ask || tags.length ? 1 : 0));

  /**
   * The instant read: on-phone rules only.
   * @param {string} [text]
   */
  function quick(text = '') {
    const local = suggest(text);
    const { level, guide } = withLinkFloor(text, levelOf(local.tags, 'low', local), classify(text));
    return { tags: [...local.tags], level, ask: local.ask, guide, explanation: '', signals: [], impersonating: '', links: [], image: null, amount: local.amount, hadImage: false, ai: false, intent: looksLikeChat(text, local) ? 'chat' : 'message', chat: '' };
  }

  /**
   * The full read. The AI decides what the message is; the rules are the floor under it.
   * @param {{text?: string, imageBase64?: string, context?: string[]}} input
   */
  async function assess({ text = '', imageBase64, context = [], audioBase64, videoBase64, videoMime } = {}) {
    let ai = null;
    try { ai = await infer({ text, imageBase64, context, audioBase64, videoBase64, videoMime }); } catch { ai = null; }
    if (ai) ai = { links: [], image: null, signals: [], steps: [], tags: [], heard: '', ...ai }; // tolerate a result that leaves a field out
    // For a call, the words are what the AI just heard on top of what was already known; the rules read all of them.
    const words = `${text} ${(ai && ai.heard) || ''}`.trim();
    const local = suggest(words);
    const ruleGuide = classify(words);

    if (ai) {
      const tags = [...new Set([...local.tags, ...ai.tags])];
      // A picture the AI thinks was computer-generated is worth a "check" on its own (a fake profile, a fake invoice, a fake
      // person), but only as a hint: it is never a STOP by itself, because AI is not reliable at telling real photos from made ones.
      const aiImg = !!(ai.image && ai.image.aiGenerated === 'likely');
      const level = Math.max(levelOf(local.tags, METHOD_RISK_OF[ai.paymentMethod] || 'low', local), aiLevel(ai), withLinkFloor(words, 0, null).level, aiImg ? 1 : 0);
      // The AI names it in its own words. If it only sees an ordinary-looking request for money, the honest headline is that
      // someone is asking, and that you cannot tell who is behind it. A deceptive link or picture gets its own headline.
      const plain = !ai.scamType || /^(ordinary|unclear|normal|nothing)/i.test(ai.scamType);
      const badLink = ai.links.some((l) => l.risk === 'high' || l.risk === 'medium');
      const badImage = !!(ai.image && (ai.image.risk === 'high' || ai.image.risk === 'medium'));
      const title = plain ? (badLink ? 'Suspicious link' : badImage ? 'Suspicious image' : aiImg ? 'Possibly an AI-made picture' : ai.moneyRequest ? 'Someone is asking you for money' : 'Nothing stands out') : ai.scamType;
      const fallbackSteps = ruleGuide ? ruleGuide.steps : badLink ? LINK_GUIDE.steps : badImage ? ['Do not trust or act on this picture.', 'Check with the person on a number you already know.'] : [];
      const guide = ai.why || ai.steps.length || badLink || badImage || aiImg
        ? { id: 'ai', title, why: ai.why || (badLink ? LINK_GUIDE.why : badImage ? 'This picture may be used to deceive you.' : aiImg ? 'This picture looks computer-generated. That is only a hint, and AI can be wrong.' : ''), steps: ai.steps.length ? ai.steps : (fallbackSteps.length ? fallbackSteps : aiImg ? ['Do not trust a person or an offer just because of this picture.', 'Check who sent it another way.'] : []) }
        : ruleGuide;
      return {
        tags, level, ask: local.ask || ai.moneyRequest, guide, explanation: ai.why, signals: ai.signals, impersonating: ai.impersonating, links: ai.links, image: ai.image,
        amount: ai.amountUSD != null ? String(ai.amountUSD) : local.amount, hadImage: !!imageBase64, ai: true, aiRisk: ai.risk, method: ai.paymentMethod,
        intent: ai.intent, chat: ai.reply, heard: ai.heard,
      };
    }

    // No AI (no key, offline, timed out): the server's own rules/analysis, then the instant rules.
    let tags = [...local.tags];
    let risk = 'low';
    try {
      const r = await analyze({ text, imageBase64, paymentMethod: local.method || 'unknown', amount: local.amount ? Number(local.amount) : null, claimedName: '', firstRequest: false });
      tags = [...new Set([...tags, ...((r && r.tags) || [])])];
      risk = (r && r.paymentRisk) || 'low';
    } catch { /* the phone's instant hints still apply */ }
    const floored = withLinkFloor(words, levelOf(tags, risk, local), ruleGuide);
    return { tags, level: floored.level, ask: local.ask, guide: floored.guide, explanation: '', signals: [], impersonating: '', links: [], image: null, amount: local.amount, hadImage: !!imageBase64, ai: false, aiRisk: null, intent: looksLikeChat(words, local) ? 'chat' : 'message', chat: '', heard: '' };
  }

  /**
   * The text to send back. rich = emoji allowed (Telegram, WhatsApp); plain = SMS-safe.
   * @param {object} a an assessment
   * @param {{rich?: boolean, sender?: object|null}} [opts]
   */
  function reply(a, { rich = true, sender = null } = {}) {
    // Someone just talking to the bot (hello, thanks, "what do you do?") gets a conversation, not a scam analysis.
    if (a.intent === 'chat' && a.level === 0) return a.chat || INTRO_REPLY;
    const where = vouchUrl ? `\n\nCheck it with their own phone in Vouch: ${vouchUrl}` : '';
    const steps = a.guide ? `\n\n${a.guide.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '';
    const signs = a.signals && a.signals.length ? `\n\nWhat stood out:\n${a.signals.map((s) => `- ${s}`).join('\n')}`
      : (a.tags.length ? `\n\nWarning signs: ${label(a.tags)}.` : '');
    const claims = a.impersonating ? `\n\nIt claims to be: ${a.impersonating}.` : '';
    const from = !sender ? '' : sender.hidden ? '\n\nFrom: someone who hid their name when forwarding, so I cannot track them.'
      : `\n\nFrom: ${[sender.handle, sender.name].filter(Boolean).join(' · ') || 'an unknown sender'}${sender.count > 1 ? `. I have flagged them ${sender.count} times now.` : '.'}`;
    const tag = a.ai ? '\n\n(Read by AI, which can warn but never clear a request.)' : '';
    const links = a.links && a.links.length
      ? `\n\nLinks:\n${a.links.map((l) => `- ${l.url}: ${l.risk.toUpperCase()} risk${l.lookalikeOf && l.risk !== 'low' ? ` (imitates ${l.lookalikeOf})` : ''}. ${l.why}`).join('\n')}\nI did not open them.` : '';
    const image = a.image
      ? `\n\nImage: ${a.image.kind || 'a picture'}.${a.image.aiGenerated === 'likely' ? ' It looks AI-generated.' : (a.image.aiGenerated === 'possible' ? ' It might be AI-generated.' : '')}${a.image.concerns.length ? ` ${a.image.concerns.join('; ')}.` : ''} AI can be wrong about images, so treat this as a hint.` : '';
    if (a.level === 2) {
      const head = a.guide ? `${a.guide.title}\n${a.guide.why}` : 'This message shows signs of a scam.';
      return `${rich ? '⚠️ ' : ''}SCAM WARNING\n\n${head}${from}${claims}${signs}${links}${image}${steps || '\n\nDo NOT send money, gift card codes or passwords. Stop replying, then call them back on a number you already know.'}${tag}${where}`;
    }
    if (a.level === 1) {
      const head = a.guide ? `${a.guide.title}\n${a.guide.why}` : `This message ${a.ask ? 'asks for money' : 'has a warning sign'}.`;
      return `${a.ask ? 'This message asks for money.\n\n' : ''}${head}${from}${claims}${signs}${links}${image}${steps || '\n\nBefore you send anything, make sure it is really them.'}${tag}${where}`;
    }
    // Nothing asked for money and nothing looked wrong. Say what was actually found, and keep the rule that only a person can clear.
    const found = a.ai && a.guide && a.guide.why ? `${a.guide.why}\n\n` : '';
    return `${found}I don't see anything in that asking for money or showing scam signs.${links}${image} I can warn but never clear a request: if someone you know asks you for money, check it with their own phone in Vouch.${where}`;
  }

  return { quick, assess, reply };
}

// The payment risk of the method the AI inferred, so a risky method lifts the level just as it does in the rules.
const LINK_GUIDE = { id: 'link', title: 'Suspicious link', why: 'This link uses a trick that real companies do not use.', steps: ['Do not tap or open the link.', "Go to the company's real website or app yourself.", 'Delete the message.'] };
// The most obvious link tricks (a raw IP address, a user@ in the address, lookalike characters, a shortener) lift the level even with no AI.
// The same red lines the call engine stops a call for (read out a code, move your money to a "safe" account, install remote access,
// hand over a PIN, a courier collecting cash, pay in gift cards) are a stop in a MESSAGE too. A single look at the words is enough: only
// the red lines can reach a stop in one look; the softer signals need time to build up, which a single message does not give them.
const RED_GUIDE = { id: 'redline', title: 'Asks for a code, your money or control of your device', why: 'Real banks and companies never ask you to read out a code, move your money to a "safe" account, share your screen, or pay in gift cards.',
  steps: ['Do not give the code, send money or install anything.', 'Do not reply to them.', 'Call the company yourself on the number on your card or their official website.'] };
function redLine(text) {
  const st = callInit();
  callStep(st, text, 0);
  return st.level >= 2;
}
function withLinkFloor(text, level, guide) {
  const floor = linkFloor(extractLinks(text));
  let lvl = level; let g = guide;
  if (floor !== 'none') { lvl = Math.max(lvl, floor === 'high' ? 2 : 1); g = !g || g.id === 'ask' ? LINK_GUIDE : g; }
  if (redLine(text)) { lvl = 2; if (!g || g.id === 'ask') g = RED_GUIDE; }
  return { level: lvl, guide: g };
}

const METHOD_RISK_OF = { gift_card: 'high', wire: 'high', crypto: 'high', venmo_cashapp_zelle: 'medium' };
