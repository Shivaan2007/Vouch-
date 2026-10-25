// Vouch Watch service. Attaches to the running Vouch server (see bot/serve.js) so every door reaches the person's app:
//   - message doors (Telegram, SMS, WhatsApp) answer in their own chat AND flash a warning in the linked Vouch app
//   - a live call listener: the phone streams short audio chunks over its signed-in socket, we return the words
//   - one-time codes that link a chat or phone number to a Vouch account (only a salted hash of the chat id is stored)
// Nothing here edits the server's own files: it uses the `io`, `db` and `httpServer` the server already exposes.
// It only WARNS. Only the friend's signed Yes from their own phone in Vouch can clear a request.
import crypto from 'node:crypto';
import { analyzeSafe } from '../server/src/analyze.js';
import { DEFAULT_MODELS, geminiConfig } from '../server/src/risk/gemini.js';
import { createCore } from './core.js';
import { createBot } from './telegram-bot.js';
import { createTwilioHandler } from './twilio-webhook.js';

const room = (id) => `user:${id}`;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_WAV_B64 = 1_800_000;   // about 40 s of 16 kHz mono audio
const LISTEN_PER_MIN = 14;       // Gemini's free tier allows about 5 requests a minute per model, and we try 3 models

/**
 * @param {{httpServer: import('node:http').Server, io: any, db: any, env?: object, fetchImpl?: typeof fetch,
 *          analyze?: Function, log?: Function, startTelegram?: boolean}} opts
 */
export function attachWatch({ httpServer, io, db, env = process.env, fetchImpl = globalThis.fetch, analyze = analyzeSafe, infer, log = () => {}, startTelegram = true }) {
  // One chat can warn several Vouch accounts (a couple sharing a Telegram chat, a family group). The first version of this
  // table was keyed by chat alone, so a second account replaced the first; watch_chats is keyed by chat AND account, and the
  // old rows are carried over.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_links (channel TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (channel, ref));
    CREATE TABLE IF NOT EXISTS watch_chats (channel TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (channel, ref, user_id));
    INSERT OR IGNORE INTO watch_chats (channel, ref, user_id, created_at) SELECT channel, ref, user_id, created_at FROM watch_links;
    CREATE TABLE IF NOT EXISTS watch_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    -- Who sent flagged messages to each account: an identifier, a name and a count. Never the message itself.
    CREATE TABLE IF NOT EXISTS watch_senders (
      user_id TEXT NOT NULL, channel TEXT NOT NULL, sender_ref TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '', display TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, flags INTEGER NOT NULL DEFAULT 0, max_level INTEGER NOT NULL DEFAULT 0,
      last_title TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, channel, sender_ref));
  `);
  // The raw chat or number is kept only so the alert bot can message the person back directly.
  try { db.exec('ALTER TABLE watch_chats ADD COLUMN target TEXT'); } catch { /* already there */ }
  const salt = env.WATCH_SALT || 'vouch-watch-v1';
  const hashRef = (channel, id) => crypto.createHash('sha256').update(`${salt}|${channel}|${id}`).digest('hex');
  const q = {
    insCode: db.prepare('INSERT OR REPLACE INTO watch_codes (code, user_id, expires_at) VALUES (?, ?, ?)'),
    delUserCodes: db.prepare('DELETE FROM watch_codes WHERE user_id = ?'),
    getCode: db.prepare('SELECT code, user_id, expires_at FROM watch_codes WHERE code = ?'),
    delCode: db.prepare('DELETE FROM watch_codes WHERE code = ?'),
    bind: db.prepare('INSERT OR REPLACE INTO watch_chats (channel, ref, user_id, created_at, target) VALUES (?, ?, ?, ?, ?)'),
    targets: db.prepare('SELECT channel, target FROM watch_chats WHERE user_id = ? AND target IS NOT NULL'),
    sGet: db.prepare('SELECT * FROM watch_senders WHERE user_id = ? AND channel = ? AND sender_ref = ?'),
    sPut: db.prepare('INSERT OR REPLACE INTO watch_senders (user_id, channel, sender_ref, handle, display, first_seen, last_seen, flags, max_level, last_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    sRaise: db.prepare('UPDATE watch_senders SET max_level = MAX(max_level, ?), last_title = ? WHERE user_id = ? AND channel = ? AND sender_ref = ?'),
    sList: db.prepare('SELECT * FROM watch_senders WHERE user_id = ? ORDER BY last_seen DESC LIMIT 30'),
    sForget: db.prepare('DELETE FROM watch_senders WHERE user_id = ? AND sender_ref = ?'),
    lookup: db.prepare('SELECT user_id FROM watch_chats WHERE channel = ? AND ref = ? ORDER BY created_at'),
    linkedFor: db.prepare('SELECT DISTINCT channel FROM watch_chats WHERE user_id = ?'),
    unlink: db.prepare('DELETE FROM watch_chats WHERE user_id = ? AND channel = ?'),
    unlinkChat: db.prepare('DELETE FROM watch_chats WHERE channel = ? AND ref = ?'),
    userName: db.prepare('SELECT name FROM users WHERE user_id = ?'),
  };
  const nameOf = (userId) => { const u = q.userName.get(userId); return (u && u.name) || 'someone'; };

  // Used by the doors: find who a chat warns (every account linked to it), link it with a one-time code, or unlink it.
  const link = {
    lookup: (channel, id) => q.lookup.all(channel, hashRef(channel, id)).map((r) => r.user_id),
    who: (channel, id) => q.lookup.all(channel, hashRef(channel, id)).map((r) => nameOf(r.user_id)),
    bind: (channel, id, code) => {
      const row = q.getCode.get(String(code).trim());
      if (!row || row.expires_at < Date.now()) return null;
      q.bind.run(channel, hashRef(channel, id), row.user_id, Date.now(), String(id));
      q.delCode.run(row.code);
      io.to(room(row.user_id)).emit('watch:linked', { channel }); // so the app flips to "Connected" by itself
      return { userId: row.user_id, name: nameOf(row.user_id), all: link.who(channel, id) };
    },
    unbindChat: (channel, id) => { q.unlinkChat.run(channel, hashRef(channel, id)); },
  };

  // What the app is told about the AI's read. Never the message.
  const aiView = (a) => ({ title: a.guide ? a.guide.title : '', why: a.guide ? a.guide.why : '', steps: a.guide ? a.guide.steps : [],
    signals: a.signals || [], impersonating: a.impersonating || '', links: a.links || [], image: a.image || null, level: a.level, risk: a.aiRisk || null, amount: a.amount || '' });

  // A flagged message lights up the person's Vouch app. Never the message itself: what kind of scam it looks like, who sent it
  // (when the app they used says), and what the AI made of it.
  function pushAlert(userId, a, source, sender = null) {
    const g = a.guide || {};
    const id = crypto.randomBytes(6).toString('hex'); // so the AI's read can be added to this very warning a moment later
    io.to(room(userId)).emit('scam:alert', {
      id, level: a.level, source, ts: Date.now(), tags: a.tags,
      title: g.title || (a.level === 2 ? 'This message looks like a scam' : 'This message asks for money'),
      why: g.why || '', steps: g.steps || [],
      ai: a.ai ? aiView(a) : null, signals: a.signals || [], impersonating: a.impersonating || '', repeat: !!a.repeat,
      sender: sender ? { handle: sender.handle || '', name: sender.name || '', hidden: !!sender.hidden, count: sender.count || 0 } : null,
    });
    return id;
  }

  // The AI finished reading after the instant warning went out: replace the generic words in that same warning with what it
  // inferred (what this is, who it claims to be, what stood out, what to do). No second alert.
  function pushAi(userId, id, a) {
    if (!a.ai || !a.guide) return;
    io.to(room(userId)).emit('scam:ai', { id, ai: aiView(a) });
  }

  // Remembers who sent flagged messages, per account, so a repeat offender is recognised (and treated as worse).
  const senderRef = (channel, sender) => hashRef(`sender:${channel}`, sender.id);
  const track = {
    note(users, channel, sender, a) {
      const ref = senderRef(channel, sender);
      const now = Date.now();
      let count = 0; let repeatScam = false;
      for (const uid of users) {
        const row = q.sGet.get(uid, channel, ref);
        if (row && row.max_level === 2) repeatScam = true;
        const flags = (row ? row.flags : 0) + 1;
        count = Math.max(count, flags);
        q.sPut.run(uid, channel, ref, sender.handle || '', sender.name || '', row ? row.first_seen : now, now, flags,
          Math.max(row ? row.max_level : 0, a.level), (a.guide && a.guide.title) || (row ? row.last_title : ''));
      }
      return { count, repeatScam };
    },
    raise(users, channel, sender, a) {
      const ref = senderRef(channel, sender);
      for (const uid of users) q.sRaise.run(a.level, (a.guide && a.guide.title) || '', uid, channel, ref);
    },
  };

  // ---- doors ----
  let telegramUser = '';
  let telegram = null;
  let ready = Promise.resolve(); // resolves once Telegram has answered, so a startup message can be honest
  if (env.BOT_TOKEN) {
    telegram = createBot({
      token: env.BOT_TOKEN, fetchImpl, analyze, infer, vouchUrl: env.VOUCH_URL || '', link, onFlag: pushAlert, onAi: pushAi, track, log,
      guardians: (env.GUARDIAN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    // Only start listening once Telegram accepts the token, so a wrong or revoked token is one clear log line, not a retry loop.
    ready = Promise.resolve(fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`)).then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.result) {
          telegramUser = j.result.username || '';
          if (startTelegram) telegram.start();
        } else log('Telegram rejected BOT_TOKEN. Get a fresh token from @BotFather (/token) and update .env. The Telegram door is off.');
      })
      .catch(() => log("Couldn't reach Telegram. The Telegram door is off."));
  }
  let twilio = null;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.PUBLIC_URL) {
    twilio = createTwilioHandler({
      authToken: env.TWILIO_AUTH_TOKEN, accountSid: env.TWILIO_ACCOUNT_SID, fromNumber: env.TWILIO_FROM || '',
      whatsappFrom: env.TWILIO_WHATSAPP_FROM || '', publicUrl: env.PUBLIC_URL.replace(/\/$/, ''), analyze, infer, vouchUrl: env.VOUCH_URL || '',
      guardians: (env.GUARDIAN_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean), fetchImpl, log,
      link, onFlag: pushAlert, path: '/watch/twilio',
    });
  }
  const channels = () => [
    ...(telegramUser ? [{ id: 'telegram', name: 'Telegram', handle: `@${telegramUser}`, url: `https://t.me/${telegramUser}` }] : []),
    ...(twilio && env.TWILIO_FROM ? [{ id: 'sms', name: 'Text message', handle: env.TWILIO_FROM }] : []),
    ...(twilio && env.TWILIO_WHATSAPP_FROM ? [{ id: 'whatsapp', name: 'WhatsApp', handle: env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', '') }] : []),
  ];

  // The Twilio route lives on the same web address as the app, so one tunnel/host serves everything.
  if (twilio) {
    const original = httpServer.listeners('request');
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req, res) => {
      if (req.url.split('?')[0] === '/watch/twilio') { twilio.handleRequest(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* gone */ } }); return; }
      for (const l of original) l.call(httpServer, req, res);
    });
  }

  // ---- call listener: audio chunk in, words out ----
  async function transcribe(wavBase64) {
    const { apiKey } = geminiConfig();
    if (!apiKey) throw Object.assign(new Error('NO_STT'), { code: 'NO_STT' });
    for (const model of DEFAULT_MODELS) {
      try {
        const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.name)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [
              { text: 'Transcribe the speech in this audio exactly as spoken, in plain text. Output only the words. If there is no speech, output nothing.' },
              { inline_data: { mime_type: 'audio/wav', data: wavBase64 } }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 400, thinkingConfig: model.thinking },
          }),
        });
        if (!res || !res.ok) continue; // this model's minute is used up, or it is retired: try the next
        const body = await res.json();
        const out = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
        return Array.isArray(out) ? out.map((p) => (p && p.text) || '').join('').trim().slice(0, 1500) : '';
      } catch { /* timeout or network: try the next model */ }
    }
    throw Object.assign(new Error('STT_FAILED'), { code: 'STT_FAILED' });
  }
  const rates = new Map();
  const allow = (key, perMin) => {
    const now = Date.now();
    const recent = (rates.get(key) || []).filter((t) => now - t < 60000);
    if (recent.length >= perMin) return false;
    recent.push(now); rates.set(key, recent);
    return true;
  };

  // The alert bot messages the person directly on every app they linked (and their family), so a warning reaches a locked
  // phone as a real push notification even when Vouch is closed.
  const core = createCore({ analyze, infer, vouchUrl: env.VOUCH_URL || '' });
  async function notifyLinked(userId, text) {
    let sentTo = 0;
    for (const t of q.targets.all(userId)) {
      try {
        if (t.channel === 'telegram' && telegram) { await telegram.say(t.target, text); sentTo += 1; }
        else if ((t.channel === 'sms' || t.channel === 'whatsapp') && twilio) { await twilio.send(t.target, text); sentTo += 1; }
      } catch { /* one app being unreachable must not stop the others */ }
    }
    return sentTo;
  }

  io.on('connection', (socket) => {
    const reply = (ack, obj) => { if (typeof ack === 'function') ack(obj); };
    const who = () => socket.data && socket.data.userId;

    socket.on('watch:status', (_p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      return reply(ack, { ok: true, channels: channels(), linked: q.linkedFor.all(uid).map((r) => r.channel), listen: !!geminiConfig().apiKey });
    });
    socket.on('watch:link', (_p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      q.delUserCodes.run(uid);
      const code = String(crypto.randomInt(100000, 1000000));
      const expiresAt = Date.now() + CODE_TTL_MS;
      q.insCode.run(code, uid, expiresAt);
      return reply(ack, { ok: true, code, expiresAt, channels: channels() });
    });
    socket.on('watch:unlink', (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      q.unlink.run(uid, String(p && p.channel));
      return reply(ack, { ok: true });
    });
    // The instant AI read for the app: the person pastes or types, and the AI's view comes back a moment later.
    socket.on('watch:read', async (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      const text = p && typeof p.text === 'string' ? p.text.slice(0, 2000) : '';
      const m = p && typeof p.imageDataUrl === 'string' ? /^data:image\/(jpeg|png|webp);base64,/.exec(p.imageDataUrl) : null;
      const imageBase64 = m ? p.imageDataUrl.slice(m[0].length) : undefined;
      if ((imageBase64 && imageBase64.length > 4_000_000) || (text.trim().length < 8 && !imageBase64)) return reply(ack, { ok: false, error: 'BAD_INPUT' });
      if (!allow(`read:${uid}`, 12)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });
      try {
        const a = await core.assess({ text, imageBase64 });
        return reply(ack, { ok: true, level: a.level, tags: a.tags, ai: a.ai, read: a.ai ? aiView(a) : null }); // never the text back
      } catch { return reply(ack, { ok: false, error: 'SERVER_ERROR' }); }
    });
    // The app flagged something it heard on a call: tell the person on every linked app, and the family.
    socket.on('watch:alert', async (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      const level = p && p.level === 2 ? 2 : 1;
      const title = p && typeof p.title === 'string' ? p.title.slice(0, 80) : 'a call';
      if (!allow(`alert:${uid}`, 6)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });
      const line = level === 2 ? `Vouch flagged your call: ${title}. Do not send anything.` : `Vouch heard someone on your call asking for money. Make sure it is really them.`;
      const n = await notifyLinked(uid, line);
      if (level === 2 && telegram) {
        const name = (q.userName.get(uid) || {}).name || 'Someone you look after';
        for (const g of telegram.guardianChats) { try { await telegram.say(g, `Heads-up: ${name} is on a call that looks like a scam (${title}). It's worth checking in with them.`); } catch { /* fine */ } }
      }
      return reply(ack, { ok: true, notified: n });
    });
    // Who has been flagged for sending this account scam messages.
    socket.on('watch:senders', (_p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      return reply(ack, { ok: true, senders: q.sList.all(uid).map((r) => ({
        id: r.sender_ref, channel: r.channel, handle: r.handle, name: r.display, flags: r.flags, maxLevel: r.max_level,
        lastTitle: r.last_title, firstSeen: r.first_seen, lastSeen: r.last_seen })) });
    });
    socket.on('watch:forget', (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      q.sForget.run(uid, String(p && p.id));
      return reply(ack, { ok: true });
    });
    socket.on('watch:listen', async (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      const wav = p && p.wav;
      if (typeof wav !== 'string' || !wav || wav.length > MAX_WAV_B64) return reply(ack, { ok: false, error: 'BAD_INPUT' });
      if (!allow(`listen:${uid}`, LISTEN_PER_MIN)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });
      try { return reply(ack, { ok: true, text: await transcribe(wav) }); } catch (e) {
        return reply(ack, { ok: false, error: e.code || 'STT_FAILED' }); // never the audio or the words
      }
    });
  });

  return { link, pushAlert, track, notifyLinked, transcribe, telegram, channels, ready, stop: () => { if (telegram) telegram.stop(); } };
}
