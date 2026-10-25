# Vouch Watch (message-watch bot)

A free Telegram bot that watches a chat for scams and warns right away. Because it is a real Telegram bot, the warning arrives as a real push notification, even when the phone is locked and Vouch is closed.

- **Private chat:** message it, or forward it any message. It answers straight away.
- **Group chat:** add it to a conversation. It stays quiet unless something looks like a scam or asks for money.
- **Guardians:** reply `/guardian` in a family chat. That chat gets a heads-up when someone gets a likely scam. The message itself is never shared.

It only warns. Only a signed Yes from the friend's own phone in Vouch can clear a request.

It uses the same risk layer as the server (`server/src/analyze.js`: rules, plus Gemini when `GEMINI_API_KEY` is set) and the same instant hints as the phone app (`web/js/lib/scan.js`). No new dependencies; Node 20+.

## Set it up (about 3 minutes)

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name. Copy the token it gives you. Keep it private.
2. For group chats: send BotFather `/setprivacy`, choose your bot, choose **Disable** (so it can read the group's messages).
3. Put these in `.env` (never commit it):
   ```
   BOT_TOKEN=123456:your-token-here
   VOUCH_URL=https://your-vouch-link
   GUARDIAN_CHAT_IDS=          # optional, comma separated; or use /guardian in a chat
   GEMINI_API_KEY=             # optional
   ```
4. Run it: `node --env-file=.env bot/telegram-bot.js`
5. Open your bot in Telegram, send `/start`, then paste a scam message.

## Demo setup
Make a Telegram group: the victim, the "scammer" teammate, the bot. Make a second group "Family" with the bot, and send `/guardian` there. When the scammer writes in the first group, the victim gets the warning and the family gets a heads-up, on their lock screens.

## Privacy
Messages are checked and dropped: nothing is stored or logged. The bot never logs the token or message text. With a Gemini key set, the text is sent to Google's Gemini API for analysis (same as the server). Guardian alerts name the person and the warning signs, never the message.

## Limits
Telegram only (it is the free route with real push). A bot cannot see other apps such as iMessage or SMS: forward those messages to it. It sees a group only if privacy mode is off.
