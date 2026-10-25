// Vouch Watch: a Telegram bot that watches a chat for scams and warns right away, with real push notifications.
//   - Message it (or forward it a message) and it answers straight away.
//   - Add it to a group chat and it watches the conversation, speaking up only when something looks like a scam.
//   - Chats registered with /guardian (family) get a heads-up, never the message itself.
// It uses the server's risk layer (rules + optional Gemini) through analyzeSafe, plus the phone's instant hints.
// It only WARNS. It never clears anything: only a signed Yes from the friend's own phone in Vouch counts.
//
//   BOT_TOKEN=... node bot/telegram-bot.js        (see bot/README.md; Node 20+, no dependencies)
import { pathToFileURL } from 'node:url';
import { analyzeSafe } from '../server/src/analyze.js';
import { createCore, createContext, label } from './core.js';

const INTRO = `I'm Vouch Watch.

Send or forward me any message that asks for money and I'll tell you right away if it looks like a scam. Add me to a group chat and I'll watch it for you.

Reply /guardian in a family chat to get a heads-up when someone you look after gets a likely scam (I never share the message itself).

I can warn you. Only a Yes from your friend's own phone in Vouch can clear a request.`;

/**
 * @param {{token: string, fetchImpl?: typeof fetch, analyze?: Function, vouchUrl?: string, guardians?: Array<string|number>, log?: Function}} opts
 */
export function createBot({
  token, fetchImpl = globalThis.fetch, analyze = analyzeSafe, vouchUrl = '', guardians = [], log = () => {},
  link = null, onFlag = () => {}, onAi = () => {}, track = null, infer,
} = {}) {
  const guardianChats = new Set(guardians.map(String));
  let running = false;

  async function api(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json();
  }
  const say = (chat_id, text) => api('sendMessage', { chat_id, text, disable_web_page_preview: true });

  // The channel-neutral engine (shared with the SMS/WhatsApp door): assess text, then word the answer.
  const core = createCore({ analyze, infer, vouchUrl });
  const memory = createContext(); // the last few messages per chat and sender, in memory only, so the AI can follow a scam as it unfolds
  const assess = (text, context, imageBase64) => core.assess({ text, context, imageBase64 });

  // A photo or image file sent to the bot: pick the biggest size, download it from Telegram, and hand the bytes to the AI.
  const MAX_IMAGE = 3_000_000;
  function imageRefOf(msg) {
    if (Array.isArray(msg.photo) && msg.photo.length) { const big = msg.photo[msg.photo.length - 1]; return { file_id: big.file_id, size: big.file_size }; }
    const d = msg.document;
    if (d && /^image\/(jpeg|png|webp)$/.test(d.mime_type || '')) return { file_id: d.file_id, size: d.file_size };
    return null;
  }
  async function fetchImage(ref) {
    try {
      if (ref.size && ref.size > MAX_IMAGE) return undefined;
      const f = await api('getFile', { file_id: ref.file_id });
      const path = f && f.result && f.result.file_path;
      if (!path) return undefined;
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
      if (!res || !res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= MAX_IMAGE ? buf.toString('base64') : undefined;
    } catch { return undefined; }
  }

  async function alertGuardians(fromChatId, name, tags) {
    const who = String(name || 'Someone you look after').slice(0, 30);
    for (const id of guardianChats) {
      if (id === String(fromChatId)) continue;
      await say(id, `Heads-up: ${who} just got a message with scam warning signs (${label(tags)}). The message itself is not shared. It's worth checking in with them.`);
    }
  }

  // Who said it. In a group that is the speaker; in a private chat it is only known when the message was forwarded, and
  // only if the original sender allows it (Telegram hides the name when someone turns that off).
  function senderOf(msg, isPrivate) {
    const fo = msg.forward_origin;
    let u = null;
    if (fo) {
      if (fo.type === 'user') u = fo.sender_user;
      else if (fo.type === 'hidden_user') u = { hidden: true, name: fo.sender_user_name };
      else if (fo.chat) u = { id: fo.chat.id, username: fo.chat.username, first_name: fo.chat.title };
    } else if (msg.forward_from) u = msg.forward_from;
    else if (msg.forward_sender_name) u = { hidden: true, name: msg.forward_sender_name };
    else if (!isPrivate) u = msg.from;
    if (!u || u.is_bot) return null;
    if (u.hidden) return { hidden: true, name: String(u.name || '').slice(0, 40) };
    return { id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40), handle: u.username ? `@${u.username}` : '' };
  }

  async function handleUpdate(update) {
    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.from || msg.from.is_bot || !msg.chat) return;
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    const text = String(msg.text || msg.caption || '');
    // "/link 123456": tie this chat to a Vouch account, so a flagged message also flashes a warning in the Vouch app.
    // Also "/start link_123456", which is what the one-tap "Open Telegram" button in Vouch sends.
    const lm = /^\/(?:link|start)(?:@\w+)?\s+(?:link_)?(\d{4,8})\b/.exec(text) || (isPrivate && /^link\s+(\d{4,8})\b/i.exec(text));
    if (lm) {
      if (!link) { await say(chatId, 'Linking is not set up on this server yet.'); return; }
      const who = link.bind('telegram', chatId, lm[1]);
      await say(chatId, who
        ? `Linked to ${who.name}'s Vouch.${who.all && who.all.length > 1 ? ` This chat now warns: ${who.all.join(', ')}.` : ''} I'll warn you here, and a warning will flash in the Vouch app. Send /who to see who this chat warns, or /unlink to stop.`
        : 'That code is wrong or has expired. In Vouch, open My people and get a new code.');
      return;
    }
    if (link && /^\/who\b/.test(text)) {
      const names = link.who('telegram', chatId);
      await say(chatId, names.length ? `This chat warns: ${names.join(', ')}.` : 'This chat is not linked to a Vouch account yet. In Vouch, tap Connect next to Telegram.');
      return;
    }
    if (link && /^\/unlink\b/.test(text)) { link.unbindChat('telegram', chatId); await say(chatId, 'Done. This chat no longer warns anyone in Vouch.'); return; }
    if (/^\/(start|help)\b/.test(text)) { await say(chatId, INTRO); return; }
    if (/^\/guardian\b/.test(text)) {
      guardianChats.add(String(chatId));
      await say(chatId, 'Done. This chat will get a heads-up (never the message itself) when someone I watch gets a likely scam.');
      return;
    }
    if (/^\/stopguardian\b/.test(text)) { guardianChats.delete(String(chatId)); await say(chatId, 'Okay, this chat will no longer get heads-ups.'); return; }
    const imageRef = imageRefOf(msg);
    if (!text.trim() && !imageRef) {
      if (isPrivate) await say(chatId, 'Send or forward me a message or a screenshot and I will check it.');
      return;
    }
    const imageBase64 = imageRef ? await fetchImage(imageRef) : undefined;
    if (imageRef && !imageBase64 && !text.trim()) { if (isPrivate) await say(chatId, "I couldn't open that picture. Try sending it as a photo, under 3 MB."); return; }
    const sender = senderOf(msg, isPrivate);
    const users = link ? link.lookup('telegram', chatId) : [];
    const q = core.quick(text);

    // Who said it: remember flagged senders per account, so a repeat offender is called out and treated as worse.
    let info = null;
    if (track && sender && !sender.hidden && users.length && q.level >= 1) {
      info = track.note(users, 'telegram', sender, q);
      if (info.repeatScam && q.level < 2) { q.level = 2; q.repeat = true; }
    }
    const view = sender ? { ...sender, count: info ? info.count : 0 } : null;

    // Someone just talking to the bot ("yo", "thanks", "what do you do?") gets a conversation, not a scam analysis.
    // The AI answers when it can; the plain introduction is only the fallback.
    if (isPrivate && q.level === 0 && q.intent === 'chat' && !sender) {
      api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      const talk = await assess(text, []);
      await say(chatId, core.reply(talk.level === 0 ? talk : q));
      return;
    }

    // 1) Instant: the on-phone read answers in a blink, and the app flashes. When nothing obvious stands out in a private chat,
    //    wait for the AI instead of saying something premature.
    const deferQuiet = isPrivate && q.level === 0;
    const speak = !deferQuiet && (isPrivate || q.level === 2 || (q.level === 1 && q.ask));
    if (deferQuiet) api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const sent = speak ? await say(chatId, core.reply(q, { sender: view })) : null;
    const alerts = []; // [account, alert id], so the AI's read can be added to the very warning already on screen
    if (q.level >= 1) for (const uid of users) alerts.push([uid, onFlag(uid, q, 'telegram', view)]);
    if (q.level === 2) await alertGuardians(chatId, msg.from.first_name, q.tags);

    // 2) Then the AI read, which INFERS what this is from the message and from what this sender said just before. Its words
    //    replace the generic ones in the same Telegram message and are filled into the warning already on the app; the app is
    //    alerted again only if the AI found it worse than the instant read did.
    const memKey = `${chatId}:${sender && !sender.hidden ? sender.id : 'me'}`;
    const full = await assess(text, memory.get(memKey), imageBase64);
    memory.add(memKey, text);
    if (info && info.repeatScam && full.level < 2) full.level = 2;
    if (deferQuiet && full.level === 0) { await say(chatId, core.reply(full, { sender: view })); return; } // the AI read it: say what it found
    const raised = full.level > q.level;
    if (!raised && full.ai) for (const [uid, id] of alerts) if (id) onAi(uid, id, full);
    if (!(raised || (full.ai && q.level >= 1) || (full.level >= 1 && !speak))) return;
    if (raised && track && sender && !sender.hidden && users.length) track.raise(users, 'telegram', sender, full);
    const final = core.reply(full, { sender: view });
    const messageId = sent && sent.result && sent.result.message_id;
    try {
      if (messageId) await api('editMessageText', { chat_id: chatId, message_id: messageId, text: final, disable_web_page_preview: true });
      else if (full.level >= 1 && (isPrivate || full.level === 2 || full.ask)) await say(chatId, final);
    } catch (e) { log('edit failed:', e.message); }
    if (raised) {
      for (const uid of users) onFlag(uid, full, 'telegram', view);
      if (full.level === 2) await alertGuardians(chatId, msg.from.first_name, full.tags);
    }
  }

  async function start() {
    running = true;
    let offset = 0;
    while (running) {
      try {
        const res = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message'] });
        if (!res.ok) throw new Error(res.description || 'getUpdates failed');
        for (const u of res.result) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { log('update failed:', e.message); }
        }
      } catch (e) {
        log('poll error:', e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  const stop = () => { running = false; };

  return { handleUpdate, assess, start, stop, guardianChats, say, alertGuardians };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('Set BOT_TOKEN (see bot/README.md). Example: node --env-file=.env bot/telegram-bot.js');
    process.exit(1);
  }
  const bot = createBot({
    token,
    vouchUrl: process.env.VOUCH_URL || '',
    guardians: (process.env.GUARDIAN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    log: (...a) => console.log(...a), // never logs the token or message text
  });
  console.log('Vouch Watch is running. Message it on Telegram.');
  bot.start();
}
