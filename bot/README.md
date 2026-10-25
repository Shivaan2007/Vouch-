# Vouch Watch (message-watch bot)

A free Telegram bot that watches a chat for scams and warns right away. Because it is a real Telegram bot, the warning arrives as a real push notification, even when the phone is locked and Vouch is closed.

- **Private chat:** message it, or forward it any message. It answers straight away.
- **Group chat:** add it to a conversation. It stays quiet unless something looks like a scam or asks for money.
- **Guardians:** reply `/guardian` in a family chat. That chat gets a heads-up when someone gets a likely scam. The message itself is never shared.

It only warns. Only a signed Yes from the friend's own phone in Vouch can clear a request.

It uses the same risk layer as the server (`server/src/analyze.js`: rules, plus Gemini when `GEMINI_API_KEY` is set) and the same instant hints as the phone app (`web/js/lib/scan.js`). No new dependencies; Node 20+.

## Run it inside Vouch (recommended)

`bot/serve.js` starts the normal Vouch server with the Watch service attached. It is `npm start` plus Watch, and it changes no server file:

```
node --env-file=.env bot/serve.js
```

What that gives the main app, on one web address:

- **Message bot linked to the app.** In Vouch, open **My people**, then **Message bot**, then **Link a chat**. Send `/link 123456` (Telegram) or `link 123456` (text or WhatsApp) from the chat you want linked. From then on, any message flagged in that chat gets the answer in the chat **and** flashes a full-screen warning in the Vouch app, with the scam type and steps (never the message itself).
- **Text and WhatsApp on the same address.** Point Twilio's webhook at `PUBLIC_URL/watch/twilio`. No second tunnel.
- **Live call listening for any browser.** If the browser can't turn speech into words (iPhone Safari often can't) or fails, the app streams short audio chunks over its signed-in socket and the server turns them into words with Gemini. Needs `GEMINI_API_KEY`. Without it the app still has the browser engine and a typed box.

Environment (`.env`, never committed):

```
BOT_TOKEN=            # Telegram, from @BotFather
GEMINI_API_KEY=       # free from Google AI Studio: risk AI and server-side call listening
TWILIO_ACCOUNT_SID=   # optional: SMS and WhatsApp
TWILIO_AUTH_TOKEN=
PUBLIC_URL=           # the public https address of this server, no trailing slash
TWILIO_FROM=          # your Twilio SMS number
TWILIO_WHATSAPP_FROM= # e.g. whatsapp:+14155238886 for the sandbox
GUARDIAN_CHAT_IDS=    # optional
GUARDIAN_NUMBERS=     # optional
VOUCH_URL=            # optional: added to replies
```

The app reads which doors exist from the server, so **Message bot** only lists what is really set up.

## Set it up on its own (about 3 minutes)

The files below also run standalone. Prefer `bot/serve.js` above, which is what connects them to the app.

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
Messages are checked and dropped: nothing is stored or logged. The bot never logs the token or message text. With a Gemini key set, the text is sent to Google's Gemini API for analysis (same as the server). Guardian alerts name the person and the warning signs, never the message. A call alert from the app never goes to guardian chats; it goes only to the chats that account linked itself.

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

## Voice (ElevenLabs, optional)

Set ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID) in .env. Then:

- **Hearing:** Telegram voice notes and the app's call listener are transcribed by ElevenLabs Scribe; Gemini judges the words (with the earlier words of the call). With no key, Gemini hears the call audio itself and voice notes get a polite no.
- **Speaking:** a voice note to the bot is answered in writing and out loud; send /voice to have every answer read aloud. The spoken verdict is the headline plus the first step.
- Nothing is stored or logged: not the audio, not the words.

## How ElevenLabs is used (and why)

Shivaan's fixed spoken alerts (`/tts/*`) speak the four standard phrases. This section is the rest.

| Where | What | Why |
| --- | --- | --- |
| Telegram voice notes, the app's call listener | **Scribe** writes down what was said; Gemini judges the words | Hearing is where Gemini audio is weakest and the words are the evidence |
| Telegram `/voice`, and any voice note you send | The verdict is read back as a voice note (headline + the first step) | People who would rather listen than read still get it |
| **Call-screening agent** (`bot/agent.js`) | An ElevenLabs voice agent answers calls forwarded from unknown numbers, talks to the caller, and asks Vouch to judge the transcript as it goes | This is the real-world answer to "a web page cannot hear a phone call": the call comes to a number Vouch controls |

**Setting up the screening agent (needs an ElevenLabs account and a Twilio number; not tested live).**
1. In `.env` set `AGENT_SECRET=<long random string>` and `AGENT_OWNER_USER_ID=<the account to warn>` (or have the agent send `owner`). Restart.
2. In ElevenLabs, create an agent with a server tool: `POST https://<your host>/watch/agent/judge`, header `x-vouch-agent-secret: <the secret>`, JSON body `{ "transcript": "<what the caller has said so far>" }`.
3. Tell the agent: call the tool after every caller turn. Reply `level 0` / `action continue`: keep chatting politely. `action screen`: say the `say` text and take a name and callback number. `action end`: say the `say` text and end the call. Never say anything else about money, and never confirm any detail about the owner.
4. Point the Twilio number at the agent, and have the person's phone forward unanswered or unknown calls to it (carrier "conditional call forwarding"; the code differs by carrier).

What it guarantees: the words the agent is told to say are **fixed strings**, never AI output, so a caller cannot plant text for the agent to repeat. The person is messaged once per call, with no caller words in it. It only warns; it never approves anything. The transcript is judged and dropped.

**Is this person real?** When a flagged message comes from a visible Telegram sender, the AI looks at their profile picture once a day (remembered in memory only, never saved) and says if it looks AI-generated. It is a hint: AI is not reliable at telling real photos from generated ones. That picture is sent to Gemini for the look, so it is a privacy trade-off; turn it off by removing the `profileHint` call in `bot/telegram-bot.js`.