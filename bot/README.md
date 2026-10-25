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
The Telegram bot only sees chats it is in; it sees a group only if privacy mode is off. A bot cannot read other apps such as iMessage by itself: forward those messages to it (Telegram) or text them to the Vouch number (SMS and WhatsApp, below).

## SMS and WhatsApp (Twilio)

`bot/twilio-webhook.js` answers texts and WhatsApp messages (and screenshots sent to the number) with the same plain-words guide. One webhook covers both: WhatsApp senders look like `whatsapp:+1...`. Forwarding works from any app, so a person can forward a message from iMessage, Messenger and so on as a text to the Vouch number.

1. Create a Twilio account. For SMS, buy a number (the trial credit covers it). For WhatsApp, use the sandbox (Messaging, Try it out, Send a WhatsApp message): each phone sends `join <your-code>` to the sandbox number once.
2. Put these in `.env` (never commit it):
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   PUBLIC_URL=https://your-public-url        # where Twilio can reach this bot, no trailing slash
   TWILIO_FROM=+1555...                      # the SMS number
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   GUARDIAN_NUMBERS=+1555...,whatsapp:+1555...   # optional heads-up recipients
   VOUCH_URL=https://your-vouch-link
   ```
3. Run it: `node --env-file=.env bot/twilio-webhook.js` (listens on port 3100), then expose it: `cloudflared tunnel --url http://localhost:3100` and use that address as `PUBLIC_URL`.
4. In the Twilio console, set the number's (or the WhatsApp sandbox's) "A message comes in" webhook to `PUBLIC_URL/twilio`, method POST.
5. Text or WhatsApp the number a scam message, or a screenshot.

Every request is checked against Twilio's `X-Twilio-Signature`; unsigned or tampered requests get a 403. Guardian heads-ups show a masked sender number and never the message.

Limits: US carriers filter texts from unregistered numbers and registration takes days; trial accounts only reach verified numbers; the WhatsApp sandbox needs the one-time join, and a production WhatsApp number needs Meta's approval. This adapter is tested against a mocked Twilio, not yet against a live account.
