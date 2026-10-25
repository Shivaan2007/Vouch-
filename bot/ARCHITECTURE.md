# How Vouch stops impostor scams, and what is real today

Scams win on speed and borrowed trust. Vouch does not try to out-guess the scammer's story (an AI-written story will always sound right). It checks **the person** and slows everything down. **AI can warn, only a person can clear.**

```
 where a request shows up        what Vouch does                              what the person gets
 ---------------------------     -----------------------------------------    ------------------------------------
 paste / share / screenshot  ->  phone hints (scan.js) + server rules/AI  ->  full-screen warning, sticky red banner,
 live call (speaker)         ->  speech -> phone hints                    ->  spoken + vibrating + notification,
 Telegram chat (bot)         ->  same risk layer (rules + Gemini)         ->  repeats until resolved, forced pause
                                         |
                                         v
                      proof: friend's own phone signs Yes / Not me  +  shared code word on calls
                                         |
                                         v
                  verdict (server AND this phone verify the signature)  ->  circle alert on Not me
```

## What is real today

| Piece | Status |
| --- | --- |
| Keys, pairing, signed Yes / Not me, both ends verify | Real. Non-extractable WebCrypto keys, tested against the real server |
| Rotating code word (generated on demand, expires with the minute) | Real. Derived on each phone; the server never sees it |
| Paste / Share (Android) / iPhone Shortcut / screenshot | Real. Screenshot is shrunk on the phone, read by the server's risk layer (Gemini when a key is set), never stored |
| Phone hints | Real. `web/js/lib/scan.js`; parity with `server/src/risk/rules.js` is tested |
| Live call watch | Real in browsers with speech recognition (Chrome/Android best). Phones often block the mic during a call; a second device always works. The browser's speech service may process the audio |
| Alerts | Spoken, vibrating (Android), notification while Vouch is open or backgrounded. **Not** native push: a closed browser tab can't be woken without server web-push |
| Telegram bot (`bot/telegram-bot.js`) | Real code, tested with a mocked Telegram. **Not yet run against live Telegram** (needs `BOT_TOKEN`). Telegram's own push reaches a locked phone |
| SMS and WhatsApp (`bot/twilio-webhook.js`) | Real code: signature-checked webhook, plain-words guide, screenshots, guardian heads-ups. Tested against a mocked Twilio, **not yet against a live account**. Needs a Twilio account (SMS also needs carrier registration) |
| iMessage | **Not possible directly** (Apple exposes no API). Forward it as a text to the Vouch number, or Share/Paste/Shortcut |
| Any other messaging app | Every app has Forward or Share: forward to Vouch's Telegram, WhatsApp or SMS number |
| Email forwarding, native app (call screening, message filter) | Not built; out of scope for the hackathon |

Nothing in the production path is simulated. The only scripted thing in the demo is the scammer's voice. `web/dev/mock-server.js` is a development reference server and is never used in the product.

## Impostor cases

| Case | Defence | Status |
| --- | --- | --- |
| Family emergency / "grandchild" with a cloned voice | Code word on the call, friend's signed Not me, circle alert | Built |
| Friend's hacked account or "new number" | Same | Built |
| Boss or coworker asks for gift cards | Pair coworkers; same checks. Gift cards never go green on a Yes alone | Built |
| Fake video call (deepfake) | The code word works on any live channel | Built (voice or video) |
| Romance / online "partner" asks for money | Can't be paired in person. AI flags secrecy, urgency, payback promises; first-request flag | Warns only |
| Bank fraud team, IRS, Social Security, tech support, police | Not pairable. Phone and server flag it; advice is "hang up, call the number on your card or their official website", with no friend button | Warns + advice. Can't verify the institution |
| Rent/contractor "we changed accounts" invoices | Screenshot is read by AI; a paired family member is the second opinion | Warns |
| Investment / crypto "opportunity" | CRYPTO + urgency tags | Warns only |
| Package / toll / fine text with a link | Money-ask and institution wording | Warns only |

## Calls

A website or bot cannot listen to a normal phone call. Today: the in-app **Watch this call** (browser speech recognition on speaker) and the **code word**, which works on voice and video. A bridged call line (a Twilio number the call is forwarded through, with live transcription) would be the next step; it needs a paid number and carrier forwarding, so it is not built. A native app could use the phone's call-screening and message-filter hooks; that is the real "Truecaller" layer and is out of scope here, but it would reuse the same engine (`web/js/lib/scan.js` and `bot/core.js`).

## Error states (what the person sees)

| Situation | Behaviour |
| --- | --- |
| Offline / reconnecting | "No connection" card; warnings about messages still work on the phone; auto re-login on reconnect |
| Server restarted and forgot this phone | Phone re-registers by itself |
| Server forgot a link | Friend stays on the phone as "Not connected" (never deleted); code word still works; relink in one tap; no duplicates |
| Friend doesn't answer | After 2 minutes: "Wait" alert, banner stays, repeats |
| Signature does not verify | Red "Signature didn't check out", whatever the server said |
| Gemini slow or down | Rules-only result, same verdict (3 s timeout) |
| Camera / microphone / clipboard / notifications denied | Plain message and a typed or pasted alternative |
| Storage blocked | Works in memory with a warning not to reload |
| Screenshot unreadable or too large | Plain message; nothing is sent |
| Rate limit / already answered / request gone | Plain messages |

## Accessibility

Large rem-based type with an A+ control; high-contrast neutral palette; 56 px targets; native radio cards and labels; dialogs with focus moved in and the page behind made inert; spoken and vibrating alerts; no animation or flashing; a forced 10-second pause on STOP alerts so a panicked tap can't dismiss them; compare-by-ear buttons so nobody has to type on a call.

## Privacy

Keys never leave the phone. The server stores only a SHA-256 of normalized text. Messages and screenshots are analysed and dropped (sent to Gemini when a key is set). Sharing puts the message in the web address briefly; the host can see it in its logs (copy and paste avoids this). Guardian alerts name the person and the warning signs, never the message.

## Next (needs the server owner; not in PROTOCOL.md yet)

1. **Intake**: an authenticated socket event, e.g. `message:report { text?, imageDataUrl?, source }`, that runs `analyzeSafe` and replies with the tags and level, and emits a `scam:alert` to that user's phone (and a no-text heads-up to their circle). This lets any channel (Telegram, SMS, email) light up the app, not just reply in its own chat.
2. **Link a phone number to a Vouch user** (salted hash only), so the SMS/WhatsApp door can also start a signed check with the person's real friend, not just warn. Today the door warns and guides; it does not ask a friend's phone.
3. **Web push** (VAPID) so alerts reach a closed browser.

Any of these changes `docs/PROTOCOL.md`, so they need the whole team.
