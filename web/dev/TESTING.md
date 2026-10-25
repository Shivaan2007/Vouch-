# Testing Vouch on two real phones

Needs the server on PROTOCOL v2 (PR #4 description lists the changes). Use two phones: **A** (Sayan) and **B** (a friend). Every phone can do both jobs: *check* a request and *be asked* about one.

## 0. Get an HTTPS link (phones need HTTPS for keys and camera)
1. On the laptop: `npm start` (port 3000).
2. In a second terminal: `cloudflared tunnel --url http://localhost:3000` (install once: `winget install Cloudflare.cloudflared`).
3. Copy the `https://....trycloudflare.com` link. Open it on both phones (iPhone: Safari; Android: Chrome).
4. First check: open `<link>/dev/crypto-test.html`, tap **Run tests** (all PASS), then **Create + save identity**, reload the page, tap **Reload → load identity and sign** (must PASS). Do this on BOTH phones.

## 1. Pair (2 minutes)
1. Phone A: open the link, type a name, **Get started**. Phone B: same.
2. A: tab **My people** → **Add someone: show my code**.
3. B: **My people** → **Scan a code** (or type the 8 characters) → **Join**.
4. Both phones show a 6-digit code. Read it out loud. It must match → tap **It matches**.

## 2. Message side (the "someone texted me" demo)
1. On A: tab **Check a message**, type `60`, pick **Venmo / Cash App / Zelle**, tap **Check now**.
2. B's phone speaks and shows: "Did you just ask A for $60.00 via Venmo?" Tap **Yes, that was me**. A shows a green **Verified** card (and speaks it).
3. Repeat, but B taps **Not me**. A gets a full-screen red **STOP. Do not send money.** (spoken, vibrates on Android). Anyone else in the circle gets a warning banner.
4. Gift cards: paste the message (or tap **Try an example scam**; amount and Gift cards fill in by themselves, and the risky phrases are flagged under the box), B taps Yes: A should stay amber (high-risk payment) with reasons.
5. Bigger amount (`100`): B must also retype the amount; A is asked for the shared word (step 3).

## 3. Call side (the "someone is calling me" demo)
1. Both phones: tab **On a call**. Both show the **same two words**, changing every minute.
2. Call each other. A asks "What's our word?". B reads it. A types it into **Check what they said**: **Match**.
3. Type a wrong word: **No match. Don't trust this call.**

## 4. Android "Share to Vouch" (optional)
Chrome menu → **Install app** / **Add to Home screen**. Then in Messages, long-press a message → **Share** → **Vouch**: the Check tab opens with the message pasted in. iPhone has no share target; use **Paste the message** instead.

## 5. Accessibility spot checks
- Tap **A+** twice: text gets much bigger, nothing gets cut off.
- Turn on VoiceOver / TalkBack: tabs, the prompt and the STOP screen read aloud in order.
- Phone in dark mode: all text still readable.

## Pass criteria
Pairing works both ways, Yes → green, Not me → red STOP + circle alert, words match on both phones, reload keeps you signed in, a hard demo reset sends both phones back to setup.

## 6. Alerts and camera
- **My people** -> **Turn on alerts** (iPhone: Add to Home Screen first). Put Vouch in the background, then ask from the other phone: a notification should arrive.
- **Scan a code** opens a full-screen camera with a square frame. It only needs permission the first time.

## 7. The demo script (3 phones, about 2 minutes)
Roles: **Victim** (Vouch open, linked to Family), **Family** (Vouch open), **Scammer** (a normal phone + `/dev/soundboard.html` with the ElevenLabs clips in `web/dev/audio/`).

1. **Text.** Scammer texts the Victim a real message ("new number, stuck at the store, buy $200 in gift cards, don't tell mom"). Victim copies it, opens Vouch, taps **Paste the message**. The whole screen flashes **This looks like a scam**, speaks it, and vibrates. Victim taps **Ask Family's phone now**.
2. **Family's phone** speaks and shows "Did you just ask Victim for $200.00 via Gift cards?" Family taps **Not me**. Victim gets a full-screen red **STOP**; Family's circle gets a warning.
3. **Call.** Scammer calls the Victim and plays clips 1 and 2 from the soundboard. Victim opens **On a call**, says "What's our word?". Scammer plays clip 3 (dodges). Victim types a guess: full-screen **NO MATCH. Hang up.**
4. **The real one.** Family calls and says the word from their own **On a call** screen. Victim types it: **That's really Family.**

Failure modes to rehearse: tap Paste with an empty clipboard (it says what to do); deny the camera (it says to type the code); switch the phone to airplane mode (a **No connection** notice appears and clears itself on reconnect); restart the server (phones sign back in by themselves).

## 8. Code word on demand, call watcher, message bot
- **On a call -> Get our code word.** Tap it on both phones: the same two words, a countdown bar, and it hides itself when the minute ends. Tap again for a new one. **It matches / It doesn't match** gives a full-screen answer.
- **On a call -> Start watching** (call on speaker, allow the microphone). Say, near the phone: "Grandma it's me, I need $200 in gift cards, don't tell mom". A full-screen STOP appears, spoken and vibrating, with buttons for the code word and for checking with the friend's phone. Say "I need some money for the bus": the softer "Someone is asking for money" appears first. Works in Chrome on Android and desktop; iPhone Safari support varies. Some phones block the microphone during a call: put Vouch on a second phone or tablet next to it.
- **Message bot:** see `bot/README.md` (3 minutes). Message the bot a scam; the warning arrives as a real Telegram notification. Add it to a group with a "scammer" and watch it speak up. Send `/guardian` in a family chat to get heads-ups.

## 9. Real messages into Vouch
- **Any phone:** copy the message, open Vouch, **Check a message** -> **Paste the message**. A risky one flashes the full-screen warning immediately and leaves the red banner up.
- **Android:** install Vouch (browser menu -> Install app). Press and hold a message -> **Share** -> **Vouch**. The message opens in Vouch and warns at once.
- **iPhone Share sheet (optional):** the steps are in the app under **My people -> Send messages to Vouch**. They build a Shortcut that opens `<link>/?text=<message>`.
- Quick check without any setup: open `<link>/?text=new%20number%20buy%20%24200%20gift%20cards%20don%27t%20tell%20mom` on a signed-in phone. The warning should appear on load.
