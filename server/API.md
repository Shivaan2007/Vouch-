# Server notes (Person A)

The contract is `docs/PROTOCOL.md` (v2). This file only lists what the server does beyond it.

- Event names: `server/src/events.js`. Signed strings: `web/js/lib/canonical.js` (the server imports it, never rebuilds them).
- Server-issued IDs (`userId`, `requestId`): 32 lowercase hex chars.
- `verify:update` goes to the **checker**. The claimed friend gets `verify:prompt`, and a second member gets `verify:confirm_prompt`.
- After login, the server resends any pending prompt / confirm prompt and the updates of the user's last 10 minutes of requests.
- A late `verify:answer` after the 120 s timeout is refused with `NOT_ALLOWED`. Reusing a nonce or an old `ts` is `BAD_INPUT`.
- `verify:answer` is verified against a string the server builds from its own record of the request (checker, friend, amount, method),
  so a signature for different details fails with `BAD_SIGNATURE`.
- Tier 3 needs the word AND a second member. The second member is the claimed person's first other friend (not the checker).
  With no other friend the verdict stays amber with "Add a third member to your circle".
- Unexpected server errors return `SERVER_ERROR` (not in PROTOCOL §9). Limits: 5 requests/min per checker, 10 `pair:accept`/min per user.
- Auth: each connection gets exactly one `auth:challenge { nonce }`, good for one successful register/login. No second challenge is sent after success (the phone answers every challenge, so that would loop).
- `confidence.approvals` counts the **second person only**: `{ needed: 1, received: 0|1 }` at tier 3, `{ needed: 0, received: 0 }` otherwise (the phone hides the line when needed is 0).
- The retype (`retypedCents`) is required for a **Yes** at tier 2+. A Not me never needs it.
- `server/test/phone-compat.test.js` runs Sayan's real phone-side code (`web/js/lib`) against this server. `web/test/flow-v2.test.js` runs the same code against his mock server.

## Demo helpers (only when `DEMO_KEY` is set, otherwise 404)
- `GET /demo`: one-page UI. `POST /demo/reset` (header `x-demo-key`): clears requests, approvals, alerts, counters; users and pairs stay.
  `POST /demo/reset?hard=1`: also deletes users and pairs. `GET /demo/status`: users, online, pairs, open requests.
- Every reset emits `demo:reset { hard }` to all phones.

## Spoken alerts (ElevenLabs, optional)
- `GET /tts/stop | wait | ok | call` returns `audio/mpeg`. These four fixed phrases are the only ones that exist (`server/src/tts.js`). The route takes no text,
  so no message text, name or amount ever reaches ElevenLabs. Each phrase is generated once and kept in memory (at most 4 calls, ever).
- No key, no voice id, a timeout or an ElevenLabs error: the route answers `503` (`TTS_OFF`, `TTS_COOLING_DOWN`) or `502` (`TTS_FAILED`) and the
  phone must fall back to its built-in voice. After a failure the server backs off for 30 s instead of calling again.
- Env: `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (both needed), optional `ELEVENLABS_MODEL` (default `eleven_flash_v2_5`).
  The key goes only in Render's Environment or a local `.env`, never in `web/` and never in chat. `/demo/status` shows `tts: on/off` and never the key.

## Scripts
`npm run smoke -- <url> [--cleanup]` (full flow with 3 fake phones), `npm run stress [-- <url>]` (12 circles at once),
`DEMO_KEY=... npm run watch -- <url> [--once] [--reset]` (live view of who is online, pairs and open requests; `--reset` does a soft reset first),
`npm run parity` (plan test 6: same requests with the installed analyze() and with rules only; verdicts must be identical and the AI must keep every rules tag. Set `GEMINI_API_KEY` to test Gemini).

## Env
`PORT`, `DB_PATH` (default `vouch.db`), `DEMO_KEY`, `GEMINI_API_KEY` / `GEMINI_MODEL` (read by C's analyze()).
