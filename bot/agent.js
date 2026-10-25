// The call-screening agent's tool: an ElevenLabs voice agent answers a call that was forwarded to a Vouch number, talks to the caller,
// and asks Vouch "is this a scam?" as the conversation goes. Vouch judges the transcript so far (the same AI read as everywhere else)
// and tells the agent what to do next, in FIXED words. It also messages the account's linked chats, so the person finds out on their
// lock screen while the caller is still on the line.
//
//   POST /watch/agent/judge   header: x-vouch-agent-secret   body: { transcript, owner? }
//   -> { level: 0|1|2, action: "continue"|"screen"|"end", say: "<fixed sentence>" }
//
// Safety, in the same spirit as the rest of Vouch: the agent can only WARN. Nothing here clears a request or approves money. The words
// the agent is told to say are fixed strings, never AI output, so a caller cannot talk the judge into saying something else
// (prompt injection) and the agent never repeats text a stranger planted. The transcript is judged and dropped; it is never stored or
// logged.
import crypto from 'node:crypto';

const MAX_BODY = 32 * 1024;
const SAY = {
  0: { action: 'continue', say: '' },
  1: { action: 'screen', say: "I'm their assistant. Can I take your name, who you are with, and a number to call you back? I'll pass it on." },
  2: { action: 'end', say: "I can't help with that, and this call has been flagged. Goodbye." },
};
const ALERT = {
  1: 'Vouch is screening a call for you. The caller asked for money. You do not need to answer.',
  2: 'Vouch ended a call that looked like a scam. Do not call that number back.',
};

/**
 * @param {{secret: string, core: {assess: Function}, notify?: (owner: string, text: string) => Promise<unknown>,
 *          ownerOf?: (id: unknown) => string|null, defaultOwner?: string, log?: Function, now?: () => number}} opts
 */
export function createAgentTool({ secret, core, notify = async () => 0, ownerOf = () => null, defaultOwner = '', log = () => {}, now = Date.now }) {
  const recent = new Map(); // owner + level -> when we last messaged them, so one call is one message
  const hits = []; // request times, for a simple rate limit
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  async function handleRequest(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!secret || !same(req.headers['x-vouch-agent-secret'] || '', secret)) return send(res, 401, { error: 'unauthorized' });
    const t = now();
    while (hits.length && t - hits[0] > 60000) hits.shift();
    if (hits.length >= 120) return send(res, 429, { error: 'slow down' });
    hits.push(t);

    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(res, 413, { error: 'too large' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
    const transcript = body && typeof body.transcript === 'string' ? body.transcript.slice(-1500) : '';
    if (transcript.trim().length < 3) return send(res, 200, { level: 0, ...SAY[0] });

    let level = 0;
    try { level = (await core.assess({ text: transcript })).level; } catch { level = 0; } // never fail a live call over a judge error
    level = level >= 2 ? 2 : level >= 1 ? 1 : 0;

    if (level >= 1) {
      const owner = ownerOf(body.owner) || defaultOwner || null;
      const key = `${owner}:${level}`;
      if (owner && t - (recent.get(key) || 0) > 120000) {
        recent.set(key, t);
        notify(owner, ALERT[level]).catch((e) => log('agent notify failed:', e && e.message)); // not awaited: the caller is waiting
      }
    }
    return send(res, 200, { level, ...SAY[level] });
  }

  return { handleRequest };
}
