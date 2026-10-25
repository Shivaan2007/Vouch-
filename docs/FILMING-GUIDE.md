# How to film the demo (about 3 minutes, one take per flow)

Vouch is a **layer between a stranger and your money**: an AI that warns the moment something is off, and a person (a trusted friend, on their own phone) who is the only one who can clear it. AI can warn. Only a person can clear.

## Before you press record (10 minutes)
1. Laptop plugged in, watchdog running (`web/dev/keep-link-alive.ps1`); do NOT restart the server once phones are signed up (the address would change).
2. Open the current link (`%TEMP%\vouch-run\link.txt`) on each phone. Add to Home Screen. Sign up (Sayan, Tejasv, Shivaan). Add each other as trusted people.
3. Telegram: make one group with the three of you and @vouch_alert_bot. In each Vouch app tap Check a message, Open in Telegram, send `/link CODE` in the group.
4. Phones: Do Not Disturb on, brightness up, screen recording on (iPhone: Control Centre; Android: quick settings). Use light theme (Settings icon, Light).
5. Do one dry run of all three flows. Test on speaker with the real phones.

## Flow 1: "Is it really them?" (the authenticating layer), 45 s
- Tejasv "texts" Sayan asking for $200 (a normal chat).
- Sayan opens Vouch, Check a message, picks Tejasv. On Tejasv's phone: "Did you just ask Sayan for $200?". Tejasv taps No. Sayan's phone goes red: STOP.
- Repeat with Yes: green, signed by Tejasv's phone. Say: the answer is signed by a key that never leaves his phone.

## Flow 2: The scam call stays caught until you hang up, 75 s
- Sayan taps On a call, Listen for scams, phone on speaker. Tejasv plays the bank-scam clip from a second phone (web/dev/audio/bank-call.wav) or reads the script in docs/LIVE-CALL-SCENES.md.
- Show: the card says who the caller claims to be, Noticing within about 8 s, STOP about 15 s in, "Say this" coaching. Keep talking to prove it does not cut off. Then tap Stop listening: the Call summary lists what to do now, and the call is logged on Home.
- Second call: family emergency. Ask for the rotating code word; Tejasv says it; Vouch shows a match to confirm. Say: Vouch shows it, you decide.

## Flow 3: Messages, no forwarding, 60 s
- In the Telegram group, Sayan posts (from docs/DEMO-MESSAGES.md): the fake bank text with a lookalike link, then a "new number" mom message, then an AI-generated picture or short clip, then a normal message (stays quiet).
- Cut to Tejasv's phone: a banner flashes with what it is and who sent it. Tap Review for the full warning.
- Finish: type /log in the bot chat: "what I caught today", never the message text.

## Filming tips
- Film phones from above or screen-record, with a second camera on faces for reactions. Keep every warning on screen 3 s so it reads.
- Say out loud the limits (judges trust it): AI-picture detection is a hint, not proof; Vouch cannot read caller ID, so it shows who you picked or who the caller claims to be; nothing is saved but a short log of what was caught; recording is off unless switched on.
- If the link shows Cloudflare error 1033: the address changed. Open the new link from link.txt and sign in again. This only goes away with a permanent address (Render + a domain).