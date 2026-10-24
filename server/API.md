# Server API notes (Person A)

Event names live in `server/src/events.js`. If `docs/PROTOCOL.md` uses other names, change them there only.

## How calls work
Every client event takes an **ack callback**. The reply is `{ ok: true, ...data }` or `{ ok: false, error: "<code>" }`.
`web/js/lib/net.js` wraps this as `await call(event, payload)` (rejects with `Error(code)`).
Events the server pushes (no ack): `pair:done`, `verify:prompt`, `verify:confirm_prompt`, `verify:verdict`, `circle:alert`.

## Login
1. First run: `user:register { userId, name, signPub, ecdhPub }`. Keys are base64 SPKI, P-256. `userId` is 8 to 64 chars of `[A-Za-z0-9_-]`.
2. Later runs / reconnects: `auth:challenge { userId }` -> `{ challenge }`, then sign the string
   `"login|" + userId + "|" + challenge` with the signing key, send `auth:login { userId, challenge, sig }`.
3. `auth:challenge` returns `unknown_user` if the server forgot you (database wiped): call `user:register` again. `net.js` does this.
After login the server resends any pending prompt and the verdicts of your last 10 minutes of requests.

## Additions to the contract
- `verify:request` ack: `{ requestId, tier, needs: { word, second }, firstRequest }`. The first `verify:verdict` (amber, "Waiting...") follows as soon as analysis is done, so tags show at once.
- `verify:verdict` also carries `needs: { word, second }` (B shows the word box when `needs.word` and the verdict is amber after a Yes) and `stages.information.requesterName`.
- `circle:list` -> `{ circleId, friends: [{ userId, name, signPub, ecdhPub, paired }] }`.
- Tier 3 needs the word **and** a second circle member. With fewer than 3 people in the circle the verdict stays amber with an "add a third member" reason.
- The second member is asked only after the claimed friend says Yes.

## Error codes
`not_authenticated, forbidden, unknown_user, user_exists, bad_user_id, bad_name, bad_key, bad_challenge, bad_signature,
bad_token, token_used, token_expired, cannot_pair_self, key_mismatch, bad_request_id, duplicate_request, bad_amount,
bad_payment_method, bad_text, image_too_large, stale_timestamp, cannot_verify_self, unknown_friend, not_paired,
rate_limited, unknown_request, expired, already_answered, bad_answer, bad_nonce, replay, bad_word_flag, server_error`

## Verification rules
Signed string: `requestId|answer|ts|nonce`, ECDSA P-256 / SHA-256, raw r||s base64. `ts` must be within 5 minutes of server time.
A nonce can be used once, ever. Only the claimed user can answer; only the requester can send `verify:word`; only the chosen second member can `verify:confirm`.

## Env
`PORT`, `DB_PATH` (default `vouch.db`; use a persistent disk on Render or the database resets on deploy), `GEMINI_API_KEY` / `GEMINI_MODEL` (read by C's analyze()).
