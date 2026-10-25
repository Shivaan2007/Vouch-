# Vouch contracts for the risk layer

Short reference for the pieces C (`server/src/risk/`) shares with A (server) and B (phones).
**`docs/PROTOCOL.md` is the contract and wins on any disagreement.** Change nothing here without telling the whole team.

## Tags (fixed list)

`URGENCY, SECRECY, NEW_NUMBER, GIFT_CARD, WIRE, CRYPTO, PAYBACK_PROMISE, FIRST_REQUEST`

- Source of truth in code: `TAG_LIST` in `server/src/config.js`. Anything else is dropped.
- `FIRST_REQUEST` comes only from the server's `firstRequest` flag (no earlier request between the two people), never from the text.
- Gemini may only return tags from this list. Final tags = rules tags UNION Gemini tags. Gemini can never remove a tag. If Gemini returns GIFT_CARD, WIRE or CRYPTO (for example from a screenshot, which the phrase rules cannot read), payment risk becomes "high". That is the only thing Gemini can change besides tags and the explanation, and it only makes a verdict more cautious.

## Payment method and risk

| `method` | risk |
| --- | --- |
| `gift_card`, `wire`, `crypto` | high |
| `venmo_cashapp_zelle` | medium |
| `cash_in_person`, `other`, `unknown` | low |

The result is the higher of the selected method and what the text mentions (gift card, apple card, steam, itunes, google play, wire, western union, bitcoin, crypto, zelle, venmo, cash app). A text hint can raise the risk; it never lowers it. `server/src/analyze.js` also enforces that `paymentRisk` is never below the selector value.

## analyze() (C writes, A calls)

Lives in `server/src/risk/index.js`. Called through `analyzeSafe` in `server/src/analyze.js`, which adds the 3 s timeout (`GEMINI_TIMEOUT_MS`) and the validation below.

```
analyze({ text, imageBase64?, amount?, paymentMethod?, claimedName, firstRequest })
  -> { tags: [from the tag list], paymentRisk: "low"|"medium"|"high", amount: number|null,
       explanation: string (max 140 chars, display only), source: "rules"|"gemini" }
```

- `amount` is in **dollars** here (the server passes `amountCents / 100`). Everywhere else money is integer cents.
- Never throws. Any error returns the rules-only result with `source: "rules"`.
- Unknown tags, extra fields and non-string explanations are dropped or cut. `explanation` is display-only and never feeds a verdict.
- Text and screenshots are used for analysis and dropped. The server stores only a SHA-256 of normalized text.
- Honest privacy wording: "not stored by Vouch; sent to Gemini for analysis" (applies only when Gemini is on).

## decide() (A writes, pure function)

Lives in `server/src/decision.js`.

```
decide({ answer: "none"|"yes"|"not_me", tags, paymentRisk, amountCents, wordOk,
         secondConfirms, secondNo, timedOut })
  -> { verdict: "red"|"amber"|"green", reasons: [string], tier: 1|2|3, needs: { word, second } }
```

- Tiers: T1 `amountCents < 2500`, T2 2500 to 20000 (+ retyped amount + word), T3 over 20000 (+ second circle member).
- `not_me` or `secondNo` is red. No answer or timeout is never green. A Yes with high payment risk is amber.
- Tags only add reasons and never move a verdict toward green. No AI text goes in or comes out.
- Properties tested in `server/test/decision-engine.test.js` (A's file): no answer, timeout or Not me is never green; Yes with requirements met and non-high risk is green whatever the tags; adding tags never moves toward green; unknown tags or extra fields from analyze() are cleaned without a crash.

## Config (placeholders until the study gives real numbers)

`server/src/config.js`: `TIER2_MIN_CENTS=2500`, `TIER3_MIN_CENTS=20001`, `TIMEOUT_MS=120000`, `PAUSE_SECONDS=10`, `HIGH_RISK_TAG_COUNT=2`, `GEMINI_TIMEOUT_MS=3000`.

## Rule that cannot be broken

"AI can warn, only a person can clear." Everything works with zero AI. Every AI call has a 3 s timeout and a rules-only fallback.
