# Vouch

Vouch is "two-factor authentication for people": when a text or call claims to be a friend asking for money, the checker taps Check and the friend's real paired phone asks "Did you just ask <checker> for $X via <method>?".
The answer is signed by a private key that never leaves the friend's phone; the server AND the checker's phone verify it. Paired phones also share a rotating 2-word phrase for live calls.
Everything is real (WebCrypto keys, pairing, signatures); nothing is simulated. Prize track: FNB "Trust, Decisions & Financial Confidence".

## Hard rules

- Only edit files you own (table below). If something outside your files must change, draft a message to the owner.
- `docs/PROTOCOL.md` is the contract. Changes need the whole team.
- Never change the signed strings in `web/js/lib/canonical.js`.
- Locked stack: Node 20+, Express, Socket.io, better-sqlite3; plain ES-module JS in `web/`, no build step, no framework, no TypeScript. No new dependencies.
- The server is the source of truth.
- "AI can warn, only a person can clear." No AI output ever produces a verdict.
- Every AI call has a 3 s timeout plus a rule-based fallback.
- Never store or log message text or images (only SHA-256 of normalized text).
- Private keys are non-extractable. Never log keys, secrets, HMAC output, signatures, or message text.
- Run `npm test` before every commit.
- Never push without the human's OK.

## Owners

| Person | Role | Owns |
| --- | --- | --- |
| Shivaan (A) | backend + decision engine | `server/src/` (except `server/src/risk/`), `server/test/flow.test.js`, `web/js/lib/net.js`, `package.json`, `.github/`, deployment + DNS |
| Sayan (B) | frontend + crypto | all of `web/` except `web/js/lib/net.js`, `docs/PROTOCOL.md`, `CLAUDE.md`, `bot/` (Vouch Watch message bot; reads, never edits, `server/src/analyze.js`) |
| Tejasv (C) | AI + rules + story | `server/src/risk/`, `server/test/fixtures/`, `server/test/rules.test.js`, `server/test/decision.test.js`, `docs/DEMO.md`, `demo/`, README credits |

Branches: `<name>/<feature>`; PRs into protected `main` need a passing "test" check.
