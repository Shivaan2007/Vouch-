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
import { spokenVerdict } from './voice.js';

const INTRO = `I'm Vouch Watch.

Send or forward me any message that asks for money and I'll tell you right away if it looks like a scam. Add me to a group chat and I'll watch it for you.

Reply /guardian in a family chat to get a heads-up when someone you look after gets a likely scam (I never share the message itself).

I can warn you. Only a Yes from your friend's own phone in Vouch can clear a request.`;

/**
 * @param {{token: string, fetchImpl?: typeof fetch, analyze?: Function, vouchUrl?: string, guardians?: Array<string|number>, log?: Function}} opts
 */
export function createBot({
  token, fetchImpl = globalThis.fetch, analyze = analyzeSafe, vouchUrl = '', guardians = [], log = () => {},
  link = null, onFlag = () => {}, onAi = () => {}, track = null, infer, voice = null,
} = {}) {
  const guardianChats = new Set(guardians.map(String));
  let running = false;

  async function api(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json();
  }
  const say = (chat_id, text, extra = {}) => api('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
  // Under a warning that was sent on its own (not as a reply), one tap opens Vouch. Only a real https address can be a button.
  const openApp = /^https:\/\//.test(vouchUrl) ? { reply_markup: { inline_keyboard: [[{ text: 'Open Vouch', url: vouchUrl }]] } } : {};

  // The channel-neutral engine (shared with the SMS/WhatsApp door): assess text, then word the answer.
  const core = createCore({ analyze, infer, vouchUrl });
  const memory = createContext(); // the last few messages per chat and sender, in memory only, so the AI can follow a scam as it unfolds
  const assess = (text, context, imageBase64, video) => core.assess({ text, context, imageBase64, ...(video || {}) });

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

  // A short video (or video note, GIF, video file) in the chat: download it (Telegram allows bots up to 20 MB), let the AI judge it for
  // AI-generation and for anyone asking for money or codes, then forget it. Longer or bigger clips are skipped.
  const MAX_VIDEO = 14_000_000;
  function videoRefOf(msg) {
    const v = msg.video || msg.video_note || msg.animation || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
    if (!v) return null;
    let mime = v.mime_type || 'video/mp4'; if (!/^video\/(mp4|webm|quicktime|mpeg)$/.test(mime)) mime = 'video/mp4';
    return { file_id: v.file_id, size: v.file_size, mime };
  }
  async function fetchVideo(ref) {
    try {
      if (ref.size && ref.size > MAX_VIDEO) return undefined;
      const f = await api('getFile', { file_id: ref.file_id });
      const path = f && f.result && f.result.file_path;
      if (!path) return undefined;
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
      if (!res || !res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= MAX_VIDEO ? buf.toString('base64') : undefined;
    } catch { return undefined; }
  }

  // A voice note (or audio file) sent to the bot: download it, let ElevenLabs Scribe write down what was said, and judge the words
  // like any other message. The audio is never kept.
  const MAX_AUDIO = 6_000_000;
  const audioRefOf = (msg) => {
    const a = msg.voice || msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
    return a ? { file_id: a.file_id, size: a.file_size, mime: a.mime_type || 'audio/ogg' } : null;
  };
  async function hear(ref) {
    if (!voice || !voice.enabled || (ref.size && ref.size > MAX_AUDIO)) return null;
    try {
      const f = await api('getFile', { file_id: ref.file_id });
      const path = f && f.result && f.result.file_path;
      if (!path) return null;
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
      if (!res || !res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= MAX_AUDIO ? await voice.transcribe(buf, ref.mime) : null;
    } catch { return null; }
  }
  // Read the verdict aloud as a voice note (only when the person spoke to us, or asked with /voice).
  async function sayAloud(chatId, a) {
    if (!voice || !voice.enabled) return;
    try {
      const mp3 = await voice.speak(spokenVerdict(a));
      if (!mp3) return;
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([mp3], { type: 'audio/mpeg' }), 'vouch.mp3');
      await fetchImpl(`https://api.telegram.org/bot${token}/sendVoice`, { method: 'POST', body: form });
    } catch (e) { log('voice reply failed:', e.message); }
  }
  const tipped = new Set(); // chats already told how to connect, so the tip is said once
  const voiceChats = new Set(); // chats that asked to hear every answer, kept in memory only

  // Is the sender's profile picture a real person? When a flagged message comes from a visible sender, the AI looks at their
  // profile picture once (remembered for a day, in memory only; the picture itself is never kept). It is a HINT: AI is not reliable
  // at telling real photos from generated ones, and the words say so.
  const faces = new Map();
  async function profileHint(userId) {
    const id = String(userId || '');
    if (!/^\d+$/.test(id)) return null;
    const hit = faces.get(id);
    if (hit && Date.now() - hit.at < 86400000) return hit.hint;
    let hint = null;
    try {
      const r = await api('getUserProfilePhotos', { user_id: Number(id), limit: 1 });
      const sizes = r && r.result && r.result.photos && r.result.photos[0];
      if (Array.isArray(sizes) && sizes.length) {
        const biggest = sizes[sizes.length - 1];
        const img = await fetchImage({ file_id: biggest.file_id, size: biggest.file_size });
        if (img) {
          const seen = await core.assess({ text: '', imageBase64: img });
          const g = seen && seen.image && seen.image.aiGenerated;
          if (g === 'likely' || g === 'possible') hint = g;
        }
      }
    } catch { /* no picture, or Telegram will not share it: nothing to say */ }
    faces.set(id, { at: Date.now(), hint });
    return hint;
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

  // ---- Telegram Business: the bot sits on a person's OWN Telegram account (Settings, Telegram Business, Chatbots) ----
  // Anyone who messages that person is then checked, and the person is warned in their chat with the bot and in the Vouch app.
  // The bot never answers the sender and never shares the message. Needs Telegram Premium on the connected account and
  // "Business Mode" switched on for the bot in @BotFather.
  const connections = new Map(); // business connection id -> { userId, chatId, name }
  async function ownerOfConnection(id) {
    if (!id) return null;
    if (connections.has(id)) return connections.get(id);
    try {
      const r = await api('getBusinessConnection', { business_connection_id: id });
      const bc = r && r.result;
      if (bc && bc.is_enabled !== false && bc.user) {
        const owner = { userId: String(bc.user.id), chatId: bc.user_chat_id || bc.user.id, name: bc.user.first_name || 'Someone you look after' };
        connections.set(id, owner);
        return owner;
      }
    } catch { /* unknown connection: ignore the message */ }
    return null;
  }
  async function onBusinessConnection(bc) {
    if (!bc || !bc.id || !bc.user) return;
    const chatId = bc.user_chat_id || bc.user.id;
    if (bc.is_enabled === false) {
      connections.delete(bc.id);
      await say(chatId, "I'm no longer watching your Telegram messages.");
      return;
    }
    connections.set(bc.id, { userId: String(bc.user.id), chatId, name: bc.user.first_name || 'Someone you look after' });
    const linked = link && link.lookup('telegram', chatId).length;
    await say(chatId, `I'm now watching your Telegram messages. If someone writes something that looks like a scam, I'll warn you here${linked ? ' and in the Vouch app' : ''}. I never reply to them and I never share what they wrote.${linked ? '' : ' Tip: in Vouch, open My people and tap Connect next to Telegram so warnings also flash in the app.'}`);
  }

  // ---- an agent, not an alarm: every warning carries buttons, the bot remembers what it did today, and it learns from "it's fine" ----
  // All in memory, nothing about message text: only the level, the kind of scam and the sender's name or handle.
  const DAY = 86400000;
  const actionTokens = new Map(); // short token -> { chatId, sender, at }, so a button knows which sender it is about
  const muted = new Map();        // chat + sender -> until, set by "It's fine"
  const today = new Map();        // chat -> { scanned, events: [{ at, level, title, who }] }
  const log_ = (chatId) => { const k = String(chatId); if (!today.has(k)) today.set(k, { scanned: 0, events: [] }); return today.get(k); };
  const fresh = (events) => events.filter((e) => Date.now() - e.at < DAY);
  function actionKeyboard(chatId, sender) {
    if (!sender || sender.hidden || !sender.id) return {};
    const token = Math.random().toString(36).slice(2, 10);
    actionTokens.set(token, { chatId: String(chatId), sender, at: Date.now() });
    for (const [t, v] of actionTokens) if (Date.now() - v.at > DAY) actionTokens.delete(t);
    const rows = [[{ text: 'Flag sender', callback_data: `flag:${token}` }, { text: "It's fine", callback_data: `ok:${token}` }]];
    if (openApp.reply_markup) rows.push(openApp.reply_markup.inline_keyboard[0]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  async function onCallback(cq) {
    const [action, token] = String(cq.data || '').split(':');
    const ctx = actionTokens.get(token);
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const reply = (text) => api('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
    // Only the person the warning was sent to can press its buttons.
    if (!ctx || String(chatId) !== ctx.chatId) return reply('That warning has expired.');
    const users = link ? link.lookup('telegram', chatId) : [];
    if (action === 'flag') {
      if (track && users.length) track.note(users, 'telegram', ctx.sender, { level: 2, guide: { title: 'Flagged by you' } });
      muted.delete(`${ctx.chatId}:${ctx.sender.id}`);
      await reply(users.length ? "Flagged. I'll treat them as a likely scammer from now on." : 'Noted. Connect this chat to Vouch to keep a list of flagged senders.');
    } else if (action === 'ok') {
      muted.set(`${ctx.chatId}:${ctx.sender.id}`, Date.now() + 7 * DAY);
      await reply("Okay. I won't warn you about them for a week.");
    } else return reply('Unknown button.');
    api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  const DIGEST = /\b(summary|digest|what (did|have) you (catch|caught|block|see|find|do)|anything (new|happen|suspicious)|how('s| is) (it|today) going|status)\b/i;
  function digestFor(chatId) {
    const d = log_(chatId);
    const ev = fresh(d.events);
    if (!d.scanned && !ev.length) return "Nothing yet today. I'm here, and I'll tell you the moment something looks off.";
    const stops = ev.filter((e) => e.level === 2);
    const lines = [`In the last day I checked ${d.scanned} message${d.scanned === 1 ? '' : 's'} and warned you about ${ev.length}.`];
    for (const e of ev.slice(-5)) lines.push(`• ${e.level === 2 ? 'STOP' : 'Check'}: ${e.title}${e.who ? ` (from ${e.who})` : ''}`);
    if (stops.length) lines.push('Nothing was sent or cleared by me. Only a person can do that.');
    return lines.join('\n');
  }

  async function handleUpdate(update) {
    if (update && update.callback_query) return onCallback(update.callback_query);
    if (update && update.business_connection) return onBusinessConnection(update.business_connection);
    let msg = update && (update.message || update.edited_message);
    let business = false; let owner = null;
    if (update && update.business_message) {
      const bm = update.business_message;
      owner = await ownerOfConnection(bm.business_connection_id);
      // Only strangers are scanned: not the owner's own messages, not bots. Warnings go to the owner's chat with the bot.
      if (!owner || !bm.from || bm.from.is_bot || String(bm.from.id) === owner.userId) return;
      msg = { ...bm, chat: { id: owner.chatId, type: 'business' } };
      business = true;
    }
    if (!msg || !msg.from || msg.from.is_bot || !msg.chat) return;
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    let text = String(msg.text || msg.caption || '');
    // Commands are for the owner of a chat. A stranger's message arriving through Business is only ever scanned, so a "/unlink" or
    // "/start link_123456" typed by a scammer (or a judge) can never change anything.
    const cmd = business ? '' : text;
    // "/link 123456": tie this chat to a Vouch account, so a flagged message also flashes a warning in the Vouch app.
    // Also "/start link_123456", which is what the one-tap "Open Telegram" button in Vouch sends.
    const lm = /^\/(?:link|start)(?:@\w+)?\s+(?:link_)?(\d{4,8})\b/.exec(cmd) || (isPrivate && /^link\s+(\d{4,8})\b/i.exec(cmd));
    if (lm) {
      if (!link) { await say(chatId, 'Linking is not set up on this server yet.'); return; }
      const who = link.bind('telegram', chatId, lm[1]);
      await say(chatId, who
        ? `Linked to ${who.name}'s Vouch.${who.all && who.all.length > 1 ? ` This chat now warns: ${who.all.join(', ')}.` : ''} I'll warn you here, and a warning will flash in the Vouch app. Send /who to see who this chat warns, or /unlink to stop.`
        : 'That code is wrong or has expired. In Vouch, open My people and get a new code.');
      return;
    }
    if (link && /^\/who\b/.test(cmd)) {
      const names = link.who('telegram', chatId);
      await say(chatId, names.length ? `This chat warns: ${names.join(', ')}.` : 'This chat is not linked to a Vouch account yet. In Vouch, tap Connect next to Telegram.');
      return;
    }
    if (link && /^\/unlink\b/.test(cmd)) { link.unbindChat('telegram', chatId); await say(chatId, 'Done. This chat no longer warns anyone in Vouch.'); return; }
    if (/^\/(start|help)\b/.test(cmd)) { await say(chatId, INTRO); return; }
    if (/^\/(?:log|today)\b/.test(cmd)) { await say(chatId, digestFor(chatId)); return; }
    if (/^\/guardian\b/.test(cmd)) {
      guardianChats.add(String(chatId));
      await say(chatId, 'Done. This chat will get a heads-up (never the message itself) when someone I watch gets a likely scam.');
      return;
    }
    if (/^\/stopguardian\b/.test(cmd)) { guardianChats.delete(String(chatId)); await say(chatId, 'Okay, this chat will no longer get heads-ups.'); return; }
    // "/flag" as a reply to a message (or to a forwarded one): remember who sent it, for the Vouch accounts this chat warns.
    if (/^\/flag\b/.test(cmd)) {
      const users = link ? link.lookup('telegram', chatId) : [];
      if (!users.length) { await say(chatId, 'Connect this chat to your Vouch first (in Vouch: My people, Connect). Then I can remember who to watch for.'); return; }
      const target = msg.reply_to_message;
      if (!target) { await say(chatId, 'Reply to the message with /flag. In a private chat, forward the message to me first, then reply to it.'); return; }
      const who = senderOf(target, isPrivate);
      if (!target.forward_origin && target.from && msg.from && target.from.id === msg.from.id) { await say(chatId, "That message is yours, so there's no one to flag. Forward theirs to me, then reply with /flag."); return; }
      if (!who || who.hidden || !track) { await say(chatId, "I can't tell who sent that. Telegram hides the sender when someone turns off forwarding."); return; }
      track.note(users, 'telegram', who, { level: 2, guide: { title: 'Flagged by you' } });
      await say(chatId, `Done. I'll treat ${who.handle || who.name || 'them'} as a likely scammer, and you'll see them under Flagged senders in Vouch.`);
      return;
    }
    if (/^\/voice\b/.test(cmd)) {
      if (!voice || !voice.enabled) { await say(chatId, "Spoken answers aren't switched on for this bot yet."); return; }
      if (voiceChats.has(String(chatId))) { voiceChats.delete(String(chatId)); await say(chatId, 'Okay. I will answer in writing only.'); }
      else { voiceChats.add(String(chatId)); await say(chatId, 'Okay. I will also read my answers out loud. Send /voice again to turn that off.'); }
      return;
    }
    const audioRef = audioRefOf(msg);
    let spoken = false;
    if (audioRef) {
      if (!voice || !voice.enabled) { if (isPrivate) await say(chatId, "I can't listen to voice notes yet. Type what they said, or send a screenshot."); return; }
      if (isPrivate) api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      const heard = await hear(audioRef);
      if (heard === null) { if (isPrivate) await say(chatId, "I couldn't hear that clearly. Try a shorter voice note, or type what was said."); return; }
      if (!heard.trim()) { if (isPrivate) await say(chatId, 'I could not make out any words in that.'); return; }
      text = heard; spoken = true;
    }
    const imageRef = imageRefOf(msg);
    const videoRef = videoRefOf(msg);
    if (!text.trim() && !imageRef && !videoRef) {
      if (isPrivate) await say(chatId, 'Send or forward me a message or a screenshot and I will check it.');
      return;
    }
    const imageBase64 = imageRef ? await fetchImage(imageRef) : undefined;
    if (imageRef && !imageBase64 && !text.trim()) { if (isPrivate) await say(chatId, "I couldn't open that picture. Try sending it as a photo, under 3 MB."); return; }
    const videoBase64 = videoRef ? await fetchVideo(videoRef) : undefined;
    if (videoRef && !videoBase64 && !text.trim() && !imageBase64) { if (isPrivate) await say(chatId, "That video is too big for me to open (up to about 14 MB). Send a shorter clip, or a screenshot."); return; }
    const sender = senderOf(msg, isPrivate);
    // "It's fine" taught me this sender is okay: stay quiet about them for a while. (Still counted as scanned.)
    if (business && sender && (muted.get(`${chatId}:${sender.id}`) || 0) > Date.now()) { log_(chatId).scanned += 1; return; }
    if (!(isPrivate && !sender && DIGEST.test(text) && text.length < 80)) log_(chatId).scanned += 1; // asking what was caught is not itself a message that was checked
    const users = link ? link.lookup('telegram', chatId) : [];
    const q = core.quick(text);
    const kb = business && q.level >= 1 ? actionKeyboard(chatId, sender) : {};

    // Who said it: remember flagged senders per account, so a repeat offender is called out and treated as worse.
    let info = null;
    if (track && sender && !sender.hidden && users.length && q.level >= 1) {
      info = track.note(users, 'telegram', sender, q);
      if (info.repeatScam && q.level < 2) { q.level = 2; q.repeat = true; }
    }
    const view = sender ? { ...sender, count: info ? info.count : 0 } : null;

    // "What did you catch today?" is a question to an assistant, not a message to analyse.
    if (isPrivate && !sender && DIGEST.test(text) && text.length < 80) { await say(chatId, digestFor(chatId)); return; }

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
    const speak = !deferQuiet && (isPrivate || q.level === 2 || (q.level === 1 && q.ask) || (business && q.level >= 1));
    if (deferQuiet) api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const sent = speak ? await say(chatId, core.reply(q, { sender: view }), kb) : null;
    if (speak && q.level >= 1 && !users.length && link && isPrivate && !tipped.has(String(chatId))) {
      tipped.add(String(chatId));
      await say(chatId, 'Tip: this chat is not connected to Vouch, so the warning stays here. In Vouch, open My people and tap Connect next to Telegram, and warnings will flash in the app too.');
    }
    const alerts = []; // [account, alert id], so the AI's read can be added to the very warning already on screen
    if (q.level >= 1) for (const uid of users) alerts.push([uid, onFlag(uid, q, 'telegram', view)]);
    const watchedName = owner ? owner.name : msg.from.first_name; // the person being protected, not whoever wrote to them
    if (q.level === 2) await alertGuardians(chatId, watchedName, q.tags);

    // 2) Then the AI read, which INFERS what this is from the message and from what this sender said just before. Its words
    //    replace the generic ones in the same Telegram message and are filled into the warning already on the app; the app is
    //    alerted again only if the AI found it worse than the instant read did.
    const memKey = `${chatId}:${sender && !sender.hidden ? sender.id : 'me'}`;
    const full = await assess(text, memory.get(memKey), imageBase64, videoBase64 ? { videoBase64, videoMime: videoRef.mime } : undefined);
    memory.add(memKey, text);
    if (info && info.repeatScam && full.level < 2) full.level = 2;
    if (full.level >= 1) { // for "what did you catch today?": the level, the kind of scam and who, never the text
      const d = log_(chatId);
      d.events = fresh(d.events).slice(-49);
      d.events.push({ at: Date.now(), level: full.level, title: (full.guide && full.guide.title) || 'A message asking for money', who: view ? (view.handle || view.name || '') : '' });
    }
    const aloud = () => (isPrivate && (spoken || voiceChats.has(String(chatId))) ? sayAloud(chatId, full) : null);
    if (deferQuiet && full.level === 0) { await say(chatId, core.reply(full, { sender: view })); await aloud(); return; } // the AI read it: say what it found
    const raised = full.level > q.level;
    if (!raised && full.ai) for (const [uid, id] of alerts) if (id) onAi(uid, id, full);
    if (!(raised || (full.ai && q.level >= 1) || (full.level >= 1 && !speak))) { await aloud(); return; }
    if (raised && track && sender && !sender.hidden && users.length) track.raise(users, 'telegram', sender, full);
    const final = core.reply(full, { sender: view });
    const messageId = sent && sent.result && sent.result.message_id;
    try {
      if (messageId) await api('editMessageText', { chat_id: chatId, message_id: messageId, text: final, disable_web_page_preview: true, ...kb });
      else if (full.level >= 1 && (isPrivate || business || full.level === 2 || full.ask)) await say(chatId, final, kb);
    } catch (e) { log('edit failed:', e.message); }
    // The profile-picture hint goes only where the person being protected reads it: their own chat with the bot (private or
    // Business), never into a group where the sender and everyone else would see it.
    if (full.level >= 1 && sender && !sender.hidden && sender.id && (isPrivate || business)) {
      const hint = await profileHint(sender.id);
      if (hint) await say(chatId, `Their profile picture ${hint === 'likely' ? 'looks AI-generated' : 'might be AI-generated'}. Scammers often use fake faces. This is only a hint, and AI can be wrong.`);
    }
    await aloud();
    if (raised) {
      for (const uid of users) onFlag(uid, full, 'telegram', view);
      if (full.level === 2) await alertGuardians(chatId, watchedName, full.tags);
    }
  }

  async function start() {
    running = true;
    // The menu next to the message box lists what the bot can do, so nobody has to remember a command.
    api('setMyCommands', { commands: [
      { command: 'start', description: 'What I do' }, { command: 'flag', description: 'Reply to a message to flag its sender' },
      { command: 'voice', description: 'Read my answers out loud' }, { command: 'who', description: 'Who this chat warns' }, { command: 'log', description: 'What I caught today' },
      { command: 'unlink', description: 'Stop warning the Vouch app' }, { command: 'guardian', description: 'Family chat: get heads-ups' },
    ] }).catch(() => {});
    // Telegram-native: the bot introduces itself, and its menu button opens Vouch INSIDE Telegram (a mini app), so checking a message,
    // the code word and the flagged senders are one tap away without leaving the chat. Only a real https address can be a mini app.
    api('setMyDescription', { description: "Vouch Watch checks messages, links, screenshots, pictures and voice notes for scams, in plain words. Send or forward me anything suspicious, or add me to a group chat and I'll watch it. I can warn you; only a person you trust, on their own phone, can clear a request. Nothing you send is saved." }).catch(() => {});
    api('setMyShortDescription', { short_description: 'Scam checker for messages, links, pictures and voice notes. I warn; only a person can clear.' }).catch(() => {});
    if (/^https:\/\//.test(vouchUrl)) api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Vouch', web_app: { url: vouchUrl } } }).catch(() => {});
    let offset = 0;
    while (running) {
      try {
        const res = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message', 'business_connection', 'business_message', 'callback_query'] });
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

  return { handleUpdate, assess, start, stop, guardianChats, say, alertGuardians, openApp };
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
