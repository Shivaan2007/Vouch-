# Cue cards (print one per person)

Names are suggestions: Victim = "Grandma", Family = "Alex". Confirm at the first rehearsal. Total about 80 seconds.

## Ops (before every judge)

- Laptop on the phone hotspot. Server running with `node bot/serve.js` (it loads `.env`: Gemini and ElevenLabs keys and the voice ID), `cloudflared` tunnel up, link opened on both Vouch phones. Same address as the rehearsal, or everyone re-pairs.
- Warm the server: open the link, wait for "Online" on both phones.
- Soft reset: `/demo` page, enter the demo key, **Reset demo (keep friends)**. Both phones should stay paired.
- Phones: Auto-Lock Never, alerts on, volume up, brightness up, Do Not Disturb off.
- Clips copied from `demo/clips/` to `web/dev/audio/` (this laptop only). Soundboard open: play each clip once, then Stop.
- iPhones: tap the screen once after opening Vouch, so spoken alerts can play.
- Backup: the demo video and a second paired phone pair if available.

## Tejasv: presenter and scammer

1. **0-10 s** Say the hook: "AI can clone a voice, so a voice proves nothing. Vouch proves the person."
2. **10 s** Call the Victim's phone, on speaker. Play clip 1, then clip 2 (or say them).
3. Wait for the Victim to ask "What's our word?". Play clip 3 (the dodge). If it drags, clip 4.
4. **After the red STOP** step back to the narration: "The scammer never knew the word, and the real Alex said it was not them."
5. **70 s** Close: "Detecting fakes is a losing arms race. Vouch makes real people prove they're real."
6. Invite the judge to play the soundboard against the Victim.
7. **Optional coda (15 s):** "Scams are not only about money." Tell the Victim to paste the code-request text from `docs/DEMO.md` into **Check a message**. The red **DO NOT ACT ON THIS** screen appears. Do not offer the friend check for it; it is for money requests.

If a clip fails: say the line yourself.

## Shivaan: the Victim ("Grandma")

1. Phone in hand, Vouch open. Take the call on speaker.
2. Home, **On a call**, tap **Show the word for Alex**. Ask out loud: "What's our word?"
3. The caller dodges. Tap **They're asking me for money**.
4. Check form: type `200`, pick **Gift cards**, tap **Ask Alex's phone**.
5. Wait for Alex's answer. Red **STOP. Do not send money.** appears and speaks. Hold the phone up to the judge, then tap **I understand**.
6. Contrast beat: Home, **Check a message**, type `20`, pick **Venmo / Cash App / Zelle**, tap **Ask Alex's phone**.
7. Green **Verified. Safe to send.** appears. Show it.

The judge watches; you do all the typing.

## Sayan: Family ("Alex")

1. Phone in hand, Vouch open, volume up.
2. Your phone speaks: "Did you just ask Grandma for $200.00 via Gift cards?" Tap **Not me**.
3. Second prompt (the $20 Venmo): tap **Yes, that was me**.

If the phone does not speak, read the question off the screen aloud and tap anyway.

## If it goes wrong

- **Warning repeats or sounds odd:** it speaks once. If it stays silent, the screen still shows it; carry on.
- **Pairing lost:** re-pair (2 minutes) and restart from the top.
- **Stuck on "Asking their phone":** the Victim waits; amber comes within 2 minutes. Move on to the next beat verbally.
- **Never say** anything the app does not do: no 10-second pause, no study numbers.
