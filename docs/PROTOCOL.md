# Vouch PROTOCOL v2 — the contract between phones and server. Change only with the whole team.

## §0 Conventions

- Socket.io. Every client→server event uses an ack: `{ ok:true, ... }` or `{ ok:false, error:"CODE" }`.
- IDs: 32 lowercase hex chars. Times: `ts` = ms since epoch. Money: integer `amountCents`.
- Public keys: base64 of SPKI DER. Fields `signPub` (ECDSA P-256) and `exchPub` (ECDH P-256).
- Signatures: ECDSA P-256 + SHA-256, base64 of raw r||s (IEEE P1363, 64 bytes), exactly as WebCrypto outputs.
  **Server note: verify with Node `webcrypto.subtle.verify`, or `crypto.verify` with `dsaEncoding:'ieee-p1363'`. DER fails.**
- Signed strings are built ONLY by `web/js/lib/canonical.js` (also imported by the server):
  - auth:    `vouch|v2|auth|{nonce}`
  - answer:  `vouch|v2|answer|{requestId}|{checkerId}|{claimedId}|{amountCents}|{method}|{answer}|{ts}|{nonce}`   answer ∈ `yes|not_me`
  - confirm: `vouch|v2|confirm|{requestId}|{confirmerId}|{claimedId}|{amountCents}|{answer}|{ts}|{nonce}`      answer ∈ `yes|no`
- `nonce` = 16 random bytes as lowercase hex, made by the signing phone. Server rejects reused nonces and `ts` older than 5 min.

## §1 Device identity

`signKeyPair` (ECDSA P-256, private non-extractable, sign/verify) and `exchKeyPair` (ECDH P-256, private non-extractable,
deriveKey). Stored in IndexedDB on the phone. Only public keys ever leave the phone.

## §2 Auth

- On connect, server emits `auth:challenge { nonce }`.
- New device: `user:register { name (1–20 chars), signPub, exchPub, sig = sign(authString(nonce)) }` → ack `{ ok, userId }`.
- Returning device: `auth:login { userId, sig }` → ack `{ ok, user:{ id, name } }`. Unknown userId → error `UNKNOWN_USER`
  (the phone then re-registers).
- Any other event before auth → error `UNAUTHENTICATED`. The server joins each authed socket to room `user:{id}`.

## §3 Pairing

- `pair:offer {}` → ack `{ ok, token, expiresAt }`. token = 8 chars from `ABCDEFGHJKMNPQRSTVWXYZ23456789`, single use,
  5-min expiry. A's phone shows a QR of `${location.origin}/#pair=${token}` and the code as `XXXX-XXXX` (dash ignored on entry).
- B (opened the link, scanned, or typed the code): `pair:accept { token }` → ack `{ ok, peer:{ id, name, signPub, exchPub } }`.
  Server emits to A: `pair:completed { peer:{ id, name, signPub, exchPub } }`. Errors: `TOKEN_INVALID`, `ALREADY_PAIRED`, `SELF_PAIR`.
- Both phones show the SAFETY CODE: `input = sort([A.signPub,B.signPub]).join('|') + '|' + sort([A.exchPub,B.exchPub]).join('|')`;
  `h = SHA-256(utf8(input))`; `n = ((h[0]<<16)|(h[1]<<8)|h[2]) % 1000000`; display zero-padded 6 digits as `123 456`.
  Users read it aloud; a mismatch means the pairing was tampered with.
- `circle:list {}` → ack `{ ok, friends:[{ id, name, signPub, exchPub, pairedAt }] }`. "Circle" = everyone you're paired with.

## §4 Rotating word (phones only; never sent anywhere)

- `wordKey` = ECDH `deriveKey(myExchPrivate, friendExchPub)` → `{ name:'HMAC', hash:'SHA-256', length:256 }`, extractable:false, usages `['sign']`.
- `minute = Math.floor(Date.now()/60000)`; `mac = HMAC(wordKey, utf8(`vouch-word|v2|${minute}`))`.
- `word = WORDS[((mac[0]<<8)|mac[1]) % 1296] + ' ' + WORDS[((mac[2]<<8)|mac[3]) % 1296]`.
- Checking a spoken phrase: lowercase, collapse whitespace, trim; accept `minute` and `minute−1` only.
- `WORDS` = `web/js/lib/words.js` (EFF Short Wordlist #1, 1,296 words, never reordered).

## §5 Verify flow (checker = got the request; claimed = friend it claims to be from)

- `verify:request { claimedId, amountCents, method, channel, text?, imageDataUrl? }` → ack `{ ok, requestId }`.
  method ∈ `gift_card|wire|crypto|venmo_cashapp_zelle|cash_in_person|other|unknown`; channel ∈ `text|call|dm|email`.
  text ≤ 2000 chars; imageDataUrl ≤ 4 MB jpeg/png. Must be paired with `claimedId`, else `NOT_PAIRED`. Neither text nor image is stored.
- Server → claimed: `verify:prompt { requestId, checker:{ id, name }, amountCents, method, channel, tier, ts }`.
- Claimed → server: `verify:answer { requestId, answer:"yes"|"not_me", retypedCents?, ts, nonce, sig }`
  (sig over `answerString`; tier ≥ 2 requires `retypedCents === amountCents`, else error `AMOUNT_MISMATCH`).
  Errors: `BAD_SIGNATURE`, `ALREADY_ANSWERED`, `NOT_ALLOWED`.
- Tier 2+: checker's phone checks the word locally, then `verify:wordcheck { requestId, passed:true }`.
- Tier 3: server picks one other circle member of the claimed person (not the checker) and emits
  `verify:confirm_prompt { requestId, checkerName, claimedName, amountCents, method }`; they reply
  `verify:confirm { requestId, answer:"yes"|"no", ts, nonce, sig }` (sig over `confirmString`).
- Timeout: no answer within 120 s → `confidence.answer = "timeout"`.
- Server emits `verify:update` (payload §7) to the checker on every change (created, answered, word, confirm, timeout, AI tags ready).

## §6 Circle alert

On `not_me` (or a tier-3 "no"), server emits `circle:alert { impersonatedName, claimedId, requestId, ts }`
to every friend of the claimed person except the claimed person.

## §7 Objects

- Tiers: **T1** `amountCents < 2500` → signed yes. **T2** 2500–20000 → + retyped amount + word check. **T3** > 20000 → + signed yes
  from a second circle member (if the claimed person has < 3 circle members: stays amber, reason "Add a third member to your circle").
- paymentRisk: `gift_card|wire|crypto` = high; `venmo_cashapp_zelle` = medium; `cash_in_person|other|unknown` = low; use the
  higher of the selected method and what's inferred from the text.
- Tags (fixed; AI may only return these): `URGENCY, SECRECY, NEW_NUMBER, GIFT_CARD, WIRE, CRYPTO, PAYBACK_PROMISE, FIRST_REQUEST`.
- `verify:update` payload:

```
{ requestId, checkerId, claimedId, verdict:"red"|"amber"|"green", tier:1|2|3, reasons:[string], needs:{ word:bool, second:bool },
  stages:{ information:{ claimedName, amountCents, method, channel },
           understanding:{ tags:[tag], paymentRisk, explanation, firstRequest:bool },
           confidence:{ answer:"none"|"yes"|"not_me"|"timeout", wordOk:bool, approvals:{ needed, received },
                        answerSig: null | { answer, ts, nonce, sig } } } }
```

- `decide()` (Shivaan, pure): in `{ answer, tags, paymentRisk, amountCents, wordOk, secondConfirms, secondNo, timedOut }`
  → `{ verdict, reasons, tier, needs }`. `not_me` or `secondNo` → red. `none` → amber. `timedOut` → amber ("No reply. Ask for your word,
  or don't send."). `yes` + tier met + paymentRisk not high → green. `yes` + high paymentRisk → amber. Tags only add reasons and never
  move a verdict toward green. No AI output ever produces a verdict. **"AI can warn, only a person can clear."**
- Phone rule: before ever showing green, the checker's phone re-verifies `confidence.answerSig` with the friend's `signPub` saved at
  pairing (rebuilding `answerString` from the payload). If it fails → show red "Signature didn't check out", regardless of the server.

## §8 Privacy

The server never stores or logs message text or images, only SHA-256 of normalized text.

## §9 Error codes

`UNAUTHENTICATED, UNKNOWN_USER, BAD_INPUT, BAD_SIGNATURE, NOT_PAIRED, TOKEN_INVALID, ALREADY_PAIRED, SELF_PAIR,
NOT_FOUND, ALREADY_ANSWERED, AMOUNT_MISMATCH, NOT_ALLOWED, RATE_LIMITED`.
