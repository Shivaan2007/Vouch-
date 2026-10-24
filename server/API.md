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
- Auth: each connection gets `auth:challenge { nonce }`; a nonce is good for one successful register/login, after which a new challenge is emitted.

## Demo helpers (only when `DEMO_KEY` is set, otherwise 404)
- `GET /demo`: one-page UI. `POST /demo/reset` (header `x-demo-key`): clears requests, approvals, alerts, counters; users and pairs stay.
  `POST /demo/reset?hard=1`: also deletes users and pairs. `GET /demo/status`: users, online, pairs, open requests.
- Every reset emits `demo:reset { hard }` to all phones.

## Scripts
`npm run smoke -- <url> [--cleanup]` (full flow with 3 fake phones), `npm run stress [-- <url>]` (12 circles at once).

## Env
`PORT`, `DB_PATH` (default `vouch.db`), `DEMO_KEY`, `GEMINI_API_KEY` / `GEMINI_MODEL` (read by C's analyze()).
