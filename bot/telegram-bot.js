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
import { createCore, label } from './core.js';

const INTRO = `I'm Vouch Watch.

Send or forward me any message that asks for money and I'll tell you right away if it looks like a scam. Add me to a group chat and I'll watch it for you.

Reply /guardian in a family chat to get a heads-up when someone you look after gets a likely scam (I never share the message itself).

I can warn you. Only a Yes from your friend's own phone in Vouch can clear a request.`;

/**
 * @param {{token: string, fetchImpl?: typeof fetch, analyze?: Function, vouchUrl?: string, guardians?: Array<string|number>, log?: Function}} opts
 */
export function createBot({ token, fetchImpl = globalThis.fetch, analyze = analyzeSafe, vouchUrl = '', guardians = [], log = () => {} } = {}) {
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
  const core = createCore({ analyze, vouchUrl });
  const assess = (text) => core.assess({ text });
  const warning = (a) => core.reply(a, { rich: true });

  async function alertGuardians(fromChatId, name, tags) {
    const who = String(name || 'Someone you look after').slice(0, 30);
    for (const id of guardianChats) {
      if (id === String(fromChatId)) continue;
      await say(id, `Heads-up: ${who} just got a message with scam warning signs (${label(tags)}). The message itself is not shared. It's worth checking in with them.`);
    }
  }

  async function handleUpdate(update) {
    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.from || msg.from.is_bot || !msg.chat) return;
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    const text = String(msg.text || msg.caption || '');
    if (/^\/(start|help)\b/.test(text)) { await say(chatId, INTRO); return; }
    if (/^\/guardian\b/.test(text)) {
      guardianChats.add(String(chatId));
      await say(chatId, 'Done. This chat will get a heads-up (never the message itself) when someone I watch gets a likely scam.');
      return;
    }
    if (/^\/stopguardian\b/.test(text)) { guardianChats.delete(String(chatId)); await say(chatId, 'Okay, this chat will no longer get heads-ups.'); return; }
    if (!text.trim()) {
      if (isPrivate) await say(chatId, 'Send or forward me the message text and I will check it.');
      return;
    }
    const a = await assess(text);
    if (isPrivate || a.level === 2 || (a.level === 1 && a.ask)) await say(chatId, warning(a));
    if (a.level === 2) await alertGuardians(chatId, msg.from.first_name, a.tags);
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

  return { handleUpdate, assess, start, stop, guardianChats };
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
