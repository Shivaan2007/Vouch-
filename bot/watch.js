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
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_links (channel TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (channel, ref));
    CREATE TABLE IF NOT EXISTS watch_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  const salt = env.WATCH_SALT || 'vouch-watch-v1';
  const hashRef = (channel, id) => crypto.createHash('sha256').update(`${salt}|${channel}|${id}`).digest('hex');
  const q = {
    insCode: db.prepare('INSERT OR REPLACE INTO watch_codes (code, user_id, expires_at) VALUES (?, ?, ?)'),
    delUserCodes: db.prepare('DELETE FROM watch_codes WHERE user_id = ?'),
    getCode: db.prepare('SELECT code, user_id, expires_at FROM watch_codes WHERE code = ?'),
    delCode: db.prepare('DELETE FROM watch_codes WHERE code = ?'),
    bind: db.prepare('INSERT OR REPLACE INTO watch_links (channel, ref, user_id, created_at) VALUES (?, ?, ?, ?)'),
    lookup: db.prepare('SELECT user_id FROM watch_links WHERE channel = ? AND ref = ?'),
    linkedFor: db.prepare('SELECT DISTINCT channel FROM watch_links WHERE user_id = ?'),
    unlink: db.prepare('DELETE FROM watch_links WHERE user_id = ? AND channel = ?'),
    userName: db.prepare('SELECT name FROM users WHERE user_id = ?'),
  };

  // Used by the doors: find who a chat belongs to, or bind it with a one-time code.
  const link = {
    lookup: (channel, id) => { const r = q.lookup.get(channel, hashRef(channel, id)); return r ? r.user_id : null; },
    bind: (channel, id, code) => {
      const row = q.getCode.get(String(code).trim());
      if (!row || row.expires_at < Date.now()) return null;
      q.bind.run(channel, hashRef(channel, id), row.user_id, Date.now());
      q.delCode.run(row.code);
      const u = q.userName.get(row.user_id);
      return { userId: row.user_id, name: (u && u.name) || 'you' };
    },
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
  if (env.BOT_TOKEN) {
    telegram = createBot({
      token: env.BOT_TOKEN, fetchImpl, analyze, vouchUrl: env.VOUCH_URL || '', link, onFlag: pushAlert, log,
      guardians: (env.GUARDIAN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    Promise.resolve(fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`)).then((r) => r.json())
      .then((j) => { if (j && j.ok && j.result) telegramUser = j.result.username || ''; })
      .catch(() => {});
    if (startTelegram) telegram.start();
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

  return { link, pushAlert, transcribe, telegram, channels, stop: () => { if (telegram) telegram.stop(); } };
}
