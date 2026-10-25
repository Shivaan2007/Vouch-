// Vouch Watch service. Attaches to the running Vouch server (see bot/serve.js) so every door reaches the person's app:
//   - message doors (Telegram, SMS, WhatsApp) answer in their own chat AND flash a warning in the linked Vouch app
//   - a live call listener: the phone streams short audio chunks over its signed-in socket, we return the words
//   - one-time codes that link a chat or phone number to a Vouch account (only a salted hash of the chat id is stored)
// Nothing here edits the server's own files: it uses the `io`, `db` and `httpServer` the server already exposes.
// It only WARNS. Only the friend's signed Yes from their own phone in Vouch can clear a request.
import crypto from 'node:crypto';
import { analyzeSafe } from '../server/src/analyze.js';
import { DEFAULT_MODELS, geminiConfig } from '../server/src/risk/gemini.js';
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
export function attachWatch({ httpServer, io, db, env = process.env, fetchImpl = globalThis.fetch, analyze = analyzeSafe, log = () => {}, startTelegram = true }) {
  // One chat can warn several Vouch accounts (a couple sharing a Telegram chat, a family group). The first version of this
  // table was keyed by chat alone, so a second account replaced the first; watch_chats is keyed by chat AND account, and the
  // old rows are carried over.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_links (channel TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (channel, ref));
    CREATE TABLE IF NOT EXISTS watch_chats (channel TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (channel, ref, user_id));
    INSERT OR IGNORE INTO watch_chats SELECT channel, ref, user_id, created_at FROM watch_links;
    CREATE TABLE IF NOT EXISTS watch_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  const salt = env.WATCH_SALT || 'vouch-watch-v1';
  const hashRef = (channel, id) => crypto.createHash('sha256').update(`${salt}|${channel}|${id}`).digest('hex');
  const q = {
    insCode: db.prepare('INSERT OR REPLACE INTO watch_codes (code, user_id, expires_at) VALUES (?, ?, ?)'),
    delUserCodes: db.prepare('DELETE FROM watch_codes WHERE user_id = ?'),
    getCode: db.prepare('SELECT code, user_id, expires_at FROM watch_codes WHERE code = ?'),
    delCode: db.prepare('DELETE FROM watch_codes WHERE code = ?'),
    bind: db.prepare('INSERT OR REPLACE INTO watch_chats (channel, ref, user_id, created_at) VALUES (?, ?, ?, ?)'),
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
      q.bind.run(channel, hashRef(channel, id), row.user_id, Date.now());
      q.delCode.run(row.code);
      io.to(room(row.user_id)).emit('watch:linked', { channel }); // so the app flips to "Connected" by itself
      return { userId: row.user_id, name: nameOf(row.user_id), all: link.who(channel, id) };
    },
    unbindChat: (channel, id) => { q.unlinkChat.run(channel, hashRef(channel, id)); },
  };

  // A flagged message lights up the person's Vouch app. Never the message itself, only what kind of scam it looks like.
  function pushAlert(userId, a, source) {
    const g = a.guide || {};
    io.to(room(userId)).emit('scam:alert', {
      level: a.level, source, ts: Date.now(), tags: a.tags,
      title: g.title || (a.level === 2 ? 'This message looks like a scam' : 'This message asks for money'),
      why: g.why || '', steps: g.steps || [],
    });
  }

  // ---- doors ----
  let telegramUser = '';
  let telegram = null;
  let ready = Promise.resolve(); // resolves once Telegram has answered, so a startup message can be honest
  if (env.BOT_TOKEN) {
    telegram = createBot({
      token: env.BOT_TOKEN, fetchImpl, analyze, vouchUrl: env.VOUCH_URL || '', link, onFlag: pushAlert, log,
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
      whatsappFrom: env.TWILIO_WHATSAPP_FROM || '', publicUrl: env.PUBLIC_URL.replace(/\/$/, ''), analyze, vouchUrl: env.VOUCH_URL || '',
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
  const listenRate = new Map();
  const allow = (userId) => {
    const now = Date.now();
    const recent = (listenRate.get(userId) || []).filter((t) => now - t < 60000);
    if (recent.length >= LISTEN_PER_MIN) return false;
    recent.push(now); listenRate.set(userId, recent);
    return true;
  };

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
    socket.on('watch:listen', async (p, ack) => {
      const uid = who();
      if (!uid) return reply(ack, { ok: false, error: 'UNAUTHENTICATED' });
      const wav = p && p.wav;
      if (typeof wav !== 'string' || !wav || wav.length > MAX_WAV_B64) return reply(ack, { ok: false, error: 'BAD_INPUT' });
      if (!allow(uid)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });
      try { return reply(ack, { ok: true, text: await transcribe(wav) }); } catch (e) {
        return reply(ack, { ok: false, error: e.code || 'STT_FAILED' }); // never the audio or the words
      }
    });
  });

  return { link, pushAlert, transcribe, telegram, channels, ready, stop: () => { if (telegram) telegram.stop(); } };
}
