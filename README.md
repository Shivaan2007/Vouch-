# Vouch

**Two-factor authentication for people.** When a text or call claims to be a friend asking for money, Vouch checks the *person*, not the message: the friend's real, paired phone is asked "Did you just ask <you> for $X via <method>?", and their answer is signed with a key that never leaves that phone.

Built at HackPSU Fall 2026 by Shivaan (backend and decision engine), Sayan (phone app and crypto) and Tejasv (risk rules, Gemini, story). Prize track: FNB "Trust, Decisions & Financial Confidence".

## What it does

1. **Pair once.** Scan a QR code (or type a short code). Each phone makes non-extractable WebCrypto keys and the public keys are swapped through the server. Both phones show a 6-digit safety code to read aloud; a mismatch means the pairing was tampered with.
2. **Rotating word.** Paired phones show the same two-word phrase, changing every minute. It is derived on each phone from a shared secret the server never sees. On a suspicious call, ask "What's our word?".
3. **Verify ping.** Paste the message, enter the amount and how they want to be paid, tap Check. Your friend's phone asks the question; their Yes or Not me is signed, and both the server and your phone check the signature before showing a verdict.
4. **Circle alert.** On Not me, everyone paired with that friend is warned that someone is impersonating them.

More money asks for more proof: under $25 a signed Yes, up to $200 also the retyped amount and the rotating word, above $200 also a second circle member. Gift cards, wires and crypto never go green on a Yes alone.

**Scams that are not about money.** Some scams ask for a code, a password, remote access to your device, a photo of your ID or a click on a link. A friend cannot answer those, so Vouch warns instead: it spots the dangerous request (on the phone, with no AI needed), shows a plain-words guide ("Asking for a code", "Suspicious link") with three steps to take, and, if Gemini is on, adds a short explanation. It works on a pasted message, a screenshot and a live call.

**AI can warn, only a person can clear.** Rules and Gemini add plain-language warning tags (pressure to hurry, secrecy, new number, gift cards, and so on). They never produce a verdict. Everything works with no AI at all.

## Run it

Needs Node 20 or newer.

```bash
npm install
cp .env.example .env   # optional: add GEMINI_API_KEY to turn on the Gemini explanations
npm run dev            # http://localhost:3000
npm test
```

Phones need HTTPS for keys and camera, so test on real phones with `cloudflared tunnel --url http://localhost:3000` or the deployed URL. Step-by-step phone testing: [web/dev/TESTING.md](web/dev/TESTING.md). Deploying: [server/DEPLOY.md](server/DEPLOY.md). Server details: [server/API.md](server/API.md).

Without `GEMINI_API_KEY` the risk layer runs on rules only. Verdicts can only differ in one direction: Gemini may make a verdict more cautious (for example by spotting a gift-card request inside a screenshot, which the phrase rules cannot read), never less, and it can never clear a request.

## Where things are

| Path | What |
| --- | --- |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The contract between phones and server (events, signed strings, tiers) |
| [docs/contracts.md](docs/contracts.md) | The risk layer's contracts: tags, payment risk, `analyze()`, `decide()` |
| `server/src/` | Express + Socket.io + SQLite server; `decision.js` turns answers into red, amber or green |
| `server/src/risk/` | `rules.js` (phrase and payment rules) and `gemini.js` (optional AI tags and explanation) |
| `web/` | The phone app: plain ES modules, no build step |
| `bot/` | Optional Vouch Watch: Telegram, SMS and WhatsApp (via Twilio) and live-call listening, started with `node bot/serve.js`; see [bot/README.md](bot/README.md) |
| `demo/` | Demo cue cards, clip lines and the voice-consent template (the audio files are git-ignored) |
| [docs/DEMO.md](docs/DEMO.md) | The 80-second demo script |

## Privacy

The server never stores or logs message text, audio or screenshots. For each request it keeps a SHA-256 of the normalized text, the amount, method, tags and the one-line AI summary (not the message). When a Gemini key is set, pasted text, an attached screenshot and, in some modes, call words or call audio are sent to Google's Gemini API for analysis. When a flagged message comes from a visible Telegram sender, their profile picture may also be sent to Gemini to check whether it looks AI-generated (a hint, not proof). If an ElevenLabs key is set, voice notes and call audio are sent to ElevenLabs to be turned into words, and the spoken alerts send ElevenLabs only four fixed phrases (never your message, a name or an amount). Vouch does not store them. Gemini can only add warnings or make a verdict more cautious; it can never clear a request.

**Check screen.** The scam hints that flash on the phone run on the phone itself. If the server runs the Watch service with a Gemini key (`node bot/serve.js`), the app also sends what you type or paste (12 characters or more) to the Vouch server a moment after you stop typing, for an instant AI read: it goes to Gemini and is not stored. Otherwise text only leaves the phone when you tap Check now. If you use Android Share or the iPhone Shortcut instead, the message arrives in the web address (`/?text=...`): the app clears it from the browser right away and the Vouch server does not log web addresses, but the web host or tunnel in front of it may see it in its own request logs. Copy and paste avoids that.

**Call watcher (optional, off until you tap Listen to this call).** It works on a call that is on speaker, and turns speech into words in one of two ways. (1) Your browser's built-in speech recognition: the browser's own speech service may process the audio on its provider's servers, which depends on the browser and phone. (2) Listening through Vouch, used when the browser cannot listen, stops working, or on iPhone, where the browser's recognition is unreliable (needs a server running Watch with a Gemini or ElevenLabs key): the phone sends short audio clips of about 6 seconds to the Vouch server, which has the words written down and the call judged in one request to Google's Gemini (or, when an ElevenLabs key is set, has ElevenLabs Scribe write the words and Gemini judge them), and sends back only the words and a verdict. In both ways, on a server running Watch, the app also sends the most recent words heard (up to about 900 characters) to the Vouch server every few seconds for an AI read; those words go to Gemini and are not stored. A recording you pick to analyze ("Analyze a recording" under More ways) is sent the same way as live call audio. The Vouch server does not store or log the audio or the words, but Google receives them. Vouch does not record or save the call. Tell the other person on the call that you are using it; rules about listening to calls differ by place. Some phones block the microphone during a call.

**Message bot (optional, runs with `node bot/serve.js`).** Messages sent to the Telegram, SMS or WhatsApp doors pass through Telegram or Twilio, are read by the same checks and by Gemini, and are dropped: the message text is never stored or logged. To follow a scam as it unfolds, the bot keeps the last 5 messages (up to 400 characters each) from each sender in memory for 15 minutes and sends them to Gemini together with the new message. They are never written to disk and are lost when the server restarts. A screenshot sent to the bot goes to Gemini the same way. SMS and WhatsApp (through Twilio) have only been tested against a mock Twilio. Once its privacy mode is off, the Telegram bot can read every message in a group it has joined, so tell everyone in the group. Keep the bot token and Twilio credentials private.

**What the Watch service keeps in the server's database** (only when you link an app):

- **Your linked chat or number.** The Telegram chat ID or phone number you linked is stored **in plain text**, together with a salted hash of it, so the alert bot can message you back directly. Unlinking an app deletes it. The salt defaults to a public value in the code, so set `WATCH_SALT` on any real deployment.
- **One-time link codes.** Six digits, valid for 10 minutes, deleted when used.
- **Flagged senders.** When a flagged message reaches a linked chat, Vouch records who sent it (a username or name when the app shows one, plus a hashed id), how many times they were flagged, the highest warning level and the kind of scam. Never the message. These are people who are not Vouch users, and the record comes from an automatic guess that can be wrong. Records are deleted after 30 days without another flag. You can remove a sender under My people, Flagged senders. A sender who hides their name when forwarding cannot be tracked.

**Alerts to family (optional).** A heads-up to a guardian chat names the person and the kind of warning, never the message (a masked number on SMS and WhatsApp). A call alert from the app goes only to the chats that person linked to their own Vouch, with fixed wording, and never to guardian chats.

**Demo soundboard.** It only plays audio files you add yourself to a git-ignored folder. A cloned voice is used only with the speaker's written consent.

## Limitations

- Phones keep a live connection to the server, and the service worker shows background notifications where the browser allows it. It is not a native push service.
- The free hosting plan erases the database when the server sleeps, restarts or redeploys, which loses every pairing (phones keep their keys but must pair again).
- Tier thresholds and the number of warning signs are placeholders until a larger study gives real numbers.
- The warning tags come from phrase rules plus an optional model, so they can miss new scam wording. They only add caution; they cannot make a request look safe.
- The phone's instant hints (`web/js/lib/scan.js`) are a separate, simpler copy of the phrase rules, so they can show slightly different tags than the server for the same message. The result screen shows both together.
- The call watcher needs a browser with speech recognition, or a Watch server with a Gemini key to listen through Vouch, and a microphone the phone lets you use during a call. The message bot has not yet been tried end to end with real chats.
- SMS and WhatsApp warnings have only been tested against a mock Twilio, and web push alerts are not set up. The Telegram door and the in-app warnings are the ones to rely on.

## Credits

Open-source code and data used in Vouch:

| What | Used for | License |
| --- | --- | --- |
| [EFF Short Wordlist #1](https://www.eff.org/dice) (1,296 words), Electronic Frontier Foundation | The rotating two-word phrase (`web/js/lib/words.js`) | CC BY 3.0 |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | Drawing the pairing QR code (`web/vendor/qrcode.js`) | MIT |
| [jsQR](https://github.com/cozmo/jsQR) by Cosmo Wolfe | Reading the pairing QR code with the camera (`web/vendor/jsQR.js`) | Apache-2.0 |
| [Socket.IO](https://socket.io) (server and client) | Live connection between phones and server | MIT |
| [Express](https://expressjs.com) | HTTP server for the app and health check | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | The server's database | MIT |
| [Simple Icons](https://simpleicons.org) (v16.35.0) | The payment-app and channel logos in `web/img/brands/`. The names and logos are trademarks of their owners and are shown only to identify what a message mentions; Vouch is not affiliated with them | CC0 1.0 |

Services: [Google Gemini API](https://ai.google.dev) for the optional tag, explanation and speech-to-text steps; [ElevenLabs](https://elevenlabs.io) (optional) for the spoken alerts, speech-to-text and voice replies; Twilio (optional) for SMS and WhatsApp; the Telegram Bot API (optional). Browser features used: Web Crypto, IndexedDB, service workers, speech synthesis and speech recognition.
