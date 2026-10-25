// The channel-neutral engine behind every Vouch Watch door (Telegram, SMS/WhatsApp via Twilio, ...).
// Text (and optionally a screenshot) in; a level and a plain-words guide out. It only WARNS.
// Uses the server's risk layer (rules + Gemini when a key is set) through analyzeSafe, plus the phone's instant hints.
import { analyzeSafe } from '../server/src/analyze.js';
import { suggest, riskyEnough, classify, TAG_LABELS } from '../web/js/lib/scan.js';

export const label = (tags) => tags.map((t) => (TAG_LABELS[t] || t).toLowerCase()).join(', ');

/**
 * @param {{analyze?: Function, vouchUrl?: string}} [opts]
 */
export function createCore({ analyze = analyzeSafe, vouchUrl = '' } = {}) {
  /**
   * level 0 = nothing stands out; 1 = asks for money or shows a warning sign; 2 = scam warning signs (stop).
   * @param {{text?: string, imageBase64?: string}} input
   */
  async function assess({ text = '', imageBase64 } = {}) {
    const local = suggest(text);
    let tags = [...local.tags];
    let risk = 'low';
    let explanation = '';
    try {
      const r = await analyze({ text, imageBase64, paymentMethod: local.method || 'unknown', amount: local.amount ? Number(local.amount) : null, claimedName: '', firstRequest: false });
      tags = [...new Set([...tags, ...((r && r.tags) || [])])];
      risk = (r && r.paymentRisk) || 'low';
      explanation = (r && r.explanation) || '';
    } catch { /* the phone's instant hints still apply */ }
    const guide = classify(text);
    const level = riskyEnough(tags) || risk === 'high' || (local.institution && local.ask) ? 2 : (local.ask || tags.length ? 1 : 0);
    return { tags, level, ask: local.ask, guide, explanation, hadImage: !!imageBase64 };
  }

  /**
   * The text to send back. rich = emoji allowed (Telegram, WhatsApp); plain = SMS-safe.
   * @param {{tags: string[], level: number, ask: boolean, guide: object|null, explanation: string}} a
   * @param {{rich?: boolean}} [opts]
   */
  function reply(a, { rich = true } = {}) {
    const where = vouchUrl ? `\n\nCheck it with their own phone in Vouch: ${vouchUrl}` : '';
    const steps = a.guide ? `\n\n${a.guide.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '';
    const signs = a.tags.length ? `\n\nWarning signs: ${label(a.tags)}.` : '';
    if (a.level === 2) {
      const head = a.guide ? `${a.guide.title}\n${a.guide.why}` : 'This message shows signs of a scam.';
      return `${rich ? '⚠️ ' : ''}SCAM WARNING\n\n${head}${signs}${steps || '\n\nDo NOT send money, gift card codes or passwords. Stop replying, then call them back on a number you already know.'}${where}`;
    }
    if (a.level === 1) {
      const head = a.guide ? `${a.guide.title}\n${a.guide.why}` : `This message ${a.ask ? 'asks for money' : 'has a warning sign'}.`;
      return `${a.ask ? 'This message asks for money.\n\n' : ''}${head}${signs}${steps || '\n\nBefore you send anything, make sure it is really them.'}${where}`;
    }
    return `Nothing stands out. That does not make it safe: only a Yes from their own phone in Vouch counts.${where}`;
  }

  return { assess, reply };
}
