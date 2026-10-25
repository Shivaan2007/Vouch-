# Vouch

**Two-factor authentication for people.** When a text or call claims to be a friend asking for money, Vouch checks the *person*, not the message: the friend's real, paired phone is asked "Did you just ask <you> for $X via <method>?", and their answer is signed with a key that never leaves that phone.

Built at HackPSU Fall 2026 by Shivaan (backend and decision engine), Sayan (phone app and crypto) and Tejasv (risk rules, Gemini, story). Prize track: FNB "Trust, Decisions & Financial Confidence".

## What it does

1. **Pair once.** Scan a QR code (or type a short code). Each phone makes non-extractable WebCrypto keys and the public keys are swapped through the server. Both phones show a 6-digit safety code to read aloud; a mismatch means the pairing was tampered with.
2. **Rotating word.** Paired phones show the same two-word phrase, changing every minute. It is derived on each phone from a shared secret the server never sees. On a suspicious call, ask "What's our word?".
3. **Verify ping.** Paste the message, enter the amount and how they want to be paid, tap Check. Your friend's phone asks the question; their Yes or Not me is signed, and both the server and your phone check the signature before showing a verdict.
4. **Circle alert.** On Not me, everyone paired with that friend is warned that someone is impersonating them.

More money asks for more proof: under $25 a signed Yes, up to $200 also the retyped amount and the rotating word, above $200 also a second circle member. Gift cards, wires and crypto never go green on a Yes alone.

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

The server never stores or logs message text, audio or screenshots, only a SHA-256 of the normalized text. When a Gemini key is set, the pasted text (and a screenshot, if one is attached) is sent to Google's Gemini API for analysis. It is not stored by Vouch. Gemini can only add warnings and make a verdict more cautious; it can never clear a request.

**Check screen.** The scam hints that flash on the phone run on the phone itself. Pasted or typed text only leaves the phone when you tap Check now. If you use Android Share or the iPhone Shortcut instead, the message arrives in the web address (`/?text=...`): the app clears it from the browser right away and the Vouch server does not log web addresses, but the web host or tunnel in front of it may see it in its own request logs. Copy and paste avoids that.

**Call watcher (optional, off until you tap Start watching).** It works on a call that is on speaker, and turns speech into words in one of two ways. (1) Your browser's built-in speech recognition: the words stay on the phone, but the browser's own speech service may process the audio on its provider's servers, which depends on the browser and phone. (2) Listening through Vouch, used when the browser cannot listen, stops working, or you tap "Try listening through Vouch instead" (needs a server running Watch with a Gemini key): the phone sends short audio clips of about 6 seconds to the Vouch server, which passes them to Google's Gemini to get the words and sends back only the words. The Vouch server does not store or log the audio or the words, but Google receives the audio. In both ways Vouch looks for scam phrases in the words and keeps nothing. Tell the other person on the call that you are using it; rules about listening to calls differ by place. Some phones block the microphone during a call.

**Message bot (optional, runs with `node bot/serve.js`).** On Telegram, messages pass through Telegram, then through the same checks as the server, and are dropped: nothing is stored or logged. On SMS and WhatsApp (through Twilio) the message and any screenshot pass through Twilio and are checked the same way and dropped; this door has only been tested against a mock Twilio, not a live account. Linking a chat or number to your Vouch account stores only a salted hash of its id, and a flagged message lights up a warning in the app that names the kind of scam, never the message. If a Gemini key is set the text goes to Gemini as above. Once its privacy mode is off, the Telegram bot can read every message in a group it has joined, so tell everyone in the group. Family heads-up alerts name the person (a masked number on SMS and WhatsApp) and the warning signs, never the message. Keep the bot token and Twilio credentials private.

**Demo soundboard.** It only plays audio files you add yourself to a git-ignored folder. A cloned voice is used only with the speaker's written consent.

## Limitations

- Phones keep a live connection to the server, and the service worker shows background notifications where the browser allows it. It is not a native push service.
- The free hosting plan erases the database when the server sleeps, restarts or redeploys, which loses every pairing (phones keep their keys but must pair again).
- Tier thresholds and the number of warning signs are placeholders until a larger study gives real numbers.
- The warning tags come from phrase rules plus an optional model, so they can miss new scam wording. They only add caution; they cannot make a request look safe.
- The phone's instant hints (`web/js/lib/scan.js`) are a separate, simpler copy of the phrase rules, so they can show slightly different tags than the server for the same message. The result screen shows both together.
- The call watcher needs a browser with speech recognition and a microphone that the phone lets you use during a call; the message bot works only in Telegram.
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

Services: [Google Gemini API](https://ai.google.dev) for the optional tag, explanation and speech-to-text steps; Twilio (optional) for SMS and WhatsApp; the Telegram Bot API (optional). Browser features used: Web Crypto, IndexedDB, service workers, speech synthesis and speech recognition.
