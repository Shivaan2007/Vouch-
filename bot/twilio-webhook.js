// Vouch Watch on SMS and WhatsApp, through Twilio. One webhook covers both (WhatsApp senders look like "whatsapp:+1...").
// Forward or send it a suspicious message (text, or a screenshot) and it answers with a plain-words guide, immediately.
// Family chats registered as guardians get a heads-up (never the message). No dependencies, no Twilio SDK.
//
//   node --env-file=.env bot/twilio-webhook.js        (see bot/README.md)
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCore, label } from './core.js';

const MAX_BODY = 64 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Twilio's request signature: base64(HMAC-SHA1(authToken, url + each POST field sorted by name, name then value)). */
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (text) => `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${xml(text)}</Message>` : ''}</Response>`;

/**
 * @param {{authToken: string, accountSid: string, fromNumber?: string, whatsappFrom?: string, publicUrl: string,
 *          analyze?: Function, vouchUrl?: string, guardians?: string[], fetchImpl?: typeof fetch, log?: Function}} opts
 */
export function createTwilioHandler({
  authToken, accountSid, fromNumber = '', whatsappFrom = '', publicUrl, analyze, vouchUrl = '', guardians = [], fetchImpl = globalThis.fetch, log = () => {},
  link = null, onFlag = () => {}, path = '/twilio',
}) {
  const core = createCore({ analyze, vouchUrl });
  const basic = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  // A screenshot sent to the number. Twilio media needs the account credentials; only small jpeg/png are read.
  async function fetchImage(url, type) {
    if (!/^image\/(jpeg|png)$/.test(String(type))) return undefined;
    try {
      const res = await fetchImpl(url, { headers: { Authorization: basic } });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= MAX_IMAGE_BYTES ? buf.toString('base64') : undefined;
    } catch { return undefined; }
  }

  async function send(to, body) {
    const from = to.startsWith('whatsapp:') ? whatsappFrom : fromNumber;
    if (!from) return;
    await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST', headers: { Authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
  }

  /** Handles one verified incoming message. Returns the TwiML reply. */
  async function handleMessage(params) {
    const from = params.From || '';
    const whatsapp = from.startsWith('whatsapp:');
    const text = String(params.Body || '').slice(0, 2000);
    let imageBase64;
    if (Number(params.NumMedia) > 0) imageBase64 = await fetchImage(params.MediaUrl0, params.MediaContentType0);

    if (!text.trim() && !imageBase64) {
      return twiml('Forward me a suspicious message or send a screenshot and I will check it. I can warn you; only a Yes from their own phone in Vouch can clear a request.');
    }
    // "link 123456": tie this number to a Vouch account, so a flagged message also flashes a warning in the Vouch app.
    const lm = /^\s*\/?link\s+(\d{4,8})\b/i.exec(text);
    if (lm) {
      if (!link) return twiml('Linking is not set up on this server yet.');
      const who = link.bind(whatsapp ? 'whatsapp' : 'sms', from, lm[1]);
      return twiml(who ? `Linked to ${who.name}'s Vouch.${who.all && who.all.length > 1 ? ` This number now warns: ${who.all.join(', ')}.` : ''} I'll warn you here, and a warning will flash in the Vouch app. Text WHO to see who this number warns, or UNLINK to stop.`
        : 'That code is wrong or has expired. In Vouch, open My people and get a new code.');
    }
    if (link && /^\s*\/?(who|unlink)\s*$/i.test(text)) {
      const ch = whatsapp ? 'whatsapp' : 'sms';
      if (/unlink/i.test(text)) { link.unbindChat(ch, from); return twiml('Done. This number no longer warns anyone in Vouch.'); }
      const names = link.who(ch, from);
      return twiml(names.length ? `This number warns: ${names.join(', ')}.` : 'This number is not linked to a Vouch account yet. In Vouch, tap Connect next to this app.');
    }
    const a = await core.assess({ text, imageBase64 });
    if (link && a.level >= 1) {
      for (const uid of link.lookup(whatsapp ? 'whatsapp' : 'sms', from)) onFlag(uid, a, whatsapp ? 'whatsapp' : 'sms');
    }
    if (a.level === 2) {
      const who = from.replace(/^whatsapp:/, '').replace(/\d(?=\d{2})/g, '*'); // masked: the heads-up names a number, never the message
      for (const g of guardians) {
        if (g === from) continue;
        send(g, `Heads-up: ${who} just got a message with scam warning signs (${label(a.tags) || 'see the message'}). The message itself is not shared. It's worth checking in with them.`).catch(() => {});
      }
    }
    return twiml(core.reply(a, { rich: whatsapp }));
  }

  /** The HTTP entry: verifies Twilio's signature, then answers. */
  async function handleRequest(req, res) {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (req.method !== 'POST' || req.url.split('?')[0] !== path) { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { res.writeHead(413); res.end(); return; } }
    const params = Object.fromEntries(new URLSearchParams(raw));
    const want = Buffer.from(twilioSignature(authToken, `${publicUrl}${path}`, params));
    const got = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) { res.writeHead(403); res.end(); return; }
    try {
      const out = await handleMessage(params);
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(out);
    } catch (e) {
      log('twilio handler failed:', e.message); // never the message or the sender
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(twiml('Something went wrong on my side. If the message asks for money, do not send anything until you have checked with the person on a number you already know.'));
    }
  }

  return { handleMessage, handleRequest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'PUBLIC_URL'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Set ${missing.join(', ')} (see bot/README.md)`); process.exit(1); }
  const h = createTwilioHandler({
    authToken: process.env.TWILIO_AUTH_TOKEN, accountSid: process.env.TWILIO_ACCOUNT_SID,
    fromNumber: process.env.TWILIO_FROM || '', whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '',
    publicUrl: process.env.PUBLIC_URL.replace(/\/$/, ''), vouchUrl: process.env.VOUCH_URL || '',
    guardians: (process.env.GUARDIAN_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    log: (...a) => console.log(...a),
  });
  const port = Number(process.env.BOT_PORT) || 3100;
  http.createServer((req, res) => { h.handleRequest(req, res).catch(() => { res.writeHead(500); res.end(); }); })
    .listen(port, () => console.log(`Vouch Watch (Twilio) listening on :${port}. Point Twilio's webhook at ${process.env.PUBLIC_URL}/twilio`));
}
