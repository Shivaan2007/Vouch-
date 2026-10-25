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

Without `GEMINI_API_KEY` the risk layer runs on rules only and the verdicts are the same.

## Where things are

| Path | What |
| --- | --- |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The contract between phones and server (events, signed strings, tiers) |
| [docs/contracts.md](docs/contracts.md) | The risk layer's contracts: tags, payment risk, `analyze()`, `decide()` |
| `server/src/` | Express + Socket.io + SQLite server; `decision.js` turns answers into red, amber or green |
| `server/src/risk/` | `rules.js` (phrase and payment rules) and `gemini.js` (optional AI tags and explanation) |
| `web/` | The phone app: plain ES modules, no build step |

## Privacy

The server never stores or logs message text or screenshots, only a SHA-256 of the normalized text. When a Gemini key is set, the pasted text (and a screenshot, if one is sent) is sent to Google's Gemini API for analysis. It is not stored by Vouch.

## Limitations

- Phones keep a live connection to the server, and the service worker shows background notifications where the browser allows it. It is not a native push service.
- The free hosting plan erases the database when the server sleeps, restarts or redeploys, which loses every pairing (phones keep their keys but must pair again).
- Tier thresholds and the number of warning signs are placeholders until a larger study gives real numbers.
- The warning tags come from phrase rules plus an optional model, so they can miss new scam wording. They only add caution; they cannot make a request look safe.

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

Services: [Google Gemini API](https://ai.google.dev) for the optional tag and explanation step. Browser features used: Web Crypto, IndexedDB, service workers, speech synthesis.
