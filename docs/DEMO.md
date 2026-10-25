# Vouch demo: "The Grandma call" (about 80 seconds)

**The rule:** everything on the phones is real (keys, pairing, signatures, verdicts). The only scripted thing is the scammer's voice. The two defences, the shared code word and the friend's signed Not me, are exactly what a real user would do.

Written from what is in `main` (PR #19) and Sayan's demo notes. Lines marked **CONFIRM** are assumptions to settle at the first rehearsal.

## Cast and phones

| Who | Holds | Does |
| --- | --- | --- |
| **Tejasv** (presenter and scammer) | A normal phone for the call, plus a laptop or phone with `/dev/soundboard.html` | Says the hook, makes the real call, plays the scammer voice, closes. **CONFIRM** who plays the clips if Tejasv is also talking |
| **Shivaan** (the Victim, registered as "Grandma") | Vouch phone 1 | Taps through the Victim screens. The judge watches; the judge does not type |
| **Sayan** (the Family member, registered as "Alex") | Vouch phone 2 | Hears the question aloud and taps Not me, then Yes |

Grandma and Alex are paired with each other. The scammer's phone is an ordinary phone, not in Vouch. **CONFIRM** who holds which phone, and the names.

## Script

| Time | What happens | Real or scripted |
| --- | --- | --- |
| 0-10 s | **Hook.** "AI can clone a voice, so a voice proves nothing. Vouch proves the person." | Spoken |
| 10-35 s | **The call.** Tejasv phones the Victim's phone on speaker and says (or plays clips 1 and 2): "Grandma, it's me, new number, I need $200 in gift cards, don't tell Mom." The Victim opens **On a call**, taps **Get our code word**, and asks "What's our word?". The caller dodges (clip 3). | Call is real; only the voice is scripted |
| 35-55 s | **The check.** The Victim taps **They're asking me for money**. The form opens set to Phone call. The Victim types `200`, picks **Gift cards**, taps **Check now**. Alex's phone speaks "Did you just ask Grandma for $200.00 via Gift cards?" Sayan taps **Not me**. The Victim's phone goes full-screen red: **STOP. Do not send money.** | All real |
| 55-70 s | **The contrast.** A real $20 Venmo request: the Victim checks `20`, Venmo. Sayan taps **Yes, that was me**. The Victim's phone shows green **Verified. Safe to send.** | All real |
| 70-80 s | **Close.** "Detecting fakes is a losing arms race. Vouch makes real people prove they're real." | Spoken |

Then invite the judge to play the scammer from the soundboard and try to talk their way past Vouch.

Why it works as a demo: the call beat shows the word that a scammer cannot know. The check beat shows the friend's signed answer. The contrast beat shows Vouch is not just "no".

## What is real in each beat

- The call is a real phone call. The phones, keys, pairing, signed answers and verdicts are real.
- The Not me or Yes comes from Alex's own phone, signed with a key that never leaves it. Both the server and the Victim's phone check the signature before showing green.
- The tags and the sentence under "AI check" come from rules, plus Gemini if a key is set. With Gemini off the verdict is the same, except that Gemini can make one more cautious (for example by spotting a gift card in a screenshot). AI never clears a request.
- A gift-card request never goes green on a Yes alone. That is why the contrast beat uses Venmo.

## Cut list

- Message bot, call bot, Twilio, hotline: not in the demo. The family phone's alert is the real-world equivalent.
- The text-message beat: Q&A, or a 10-second coda if time allows. The Check screen has **Try an example scam** for it.
- Study numbers: no study has been run. Do not quote any numbers.
- Tier 3 (over $200, needs a second member): do not demo it.
- The judge typing on the phone: the Victim does it.
- **Call watcher** ("Start watching"): optional bonus only if rehearsal shows it works. Phones often block the microphone during a real call, and it needs the browser's speech service.
- The 10-second pause before green ("Real friends can wait 10 seconds") is not built in the app. Do not mention it.

## Setup

Free hosting loses every pairing when it sleeps or redeploys, so run the demo from the laptop (see `server/DEPLOY.md`):

1. `npm start` on the laptop, then `cloudflared tunnel --url http://localhost:3000`. Open the printed https link on the Victim and Alex phones. Put the laptop and phones on a phone hotspot, not venue Wi-Fi.
2. Register the Victim as "Grandma" and Alex as "Alex", pair them, and read the safety code aloud to confirm it matches.
3. Both phones: Auto-Lock to Never, alerts on, volume up, Vouch tab open. Android phones vibrate on alerts; iPhones do not.
4. Put the five clips in `web/dev/audio/` on the demo laptop only (see the warning below), then open `/dev/soundboard.html` and play each once.
5. Before every judge, reset the demo data (`/demo` page with `DEMO_KEY`, soft reset keeps the pairing).

**Warning on the audio files:** `web/dev/audio/` is not git-ignored and the server serves `web/` publicly. To keep the cloned voice out of the public repo, run `echo "web/dev/audio/" >> .git/info/exclude` on the demo laptop, keep the originals in `demo/clips/` (git-ignored), and never `git add -f`.

## Voice clips

The scammer voice may be an ElevenLabs clone only with the speaker's written consent (template: `demo/voice-consent.md`) and after checking ElevenLabs' voice-cloning terms. Say out loud in the demo that it is a consented cloned voice. The fallback is Tejasv saying the lines live. Lines: `demo/clips-script.md`.

## Cue cards

One card per person: `demo/cue-cards.md`.

## If something breaks

| Problem | Do |
| --- | --- |
| Alex's phone does not speak | Sayan reads the question off the screen and taps Not me anyway. The prompt is on his screen |
| Victim phone stuck on "Asking their phone" | Wait up to 2 minutes for amber, or reload and use the next judge as the retry |
| Clip will not play | Tejasv says the line live |
| Pairing lost | Re-pair on the spot (about 2 minutes). Keep a second paired pair of phones ready if you have them |
| Gemini slow or rate-limited | Nothing to do. The verdict is unchanged for text requests; only the AI sentence may be plainer |
| Camera will not scan | Type the 8-character code instead |

## If a judge asks

- **Is this real or a mock?** Real keys, real signatures, real server. Only the scammer's voice is scripted.
- **What if the friend's phone is lost or stolen?** That is a limit: a thief with an unlocked phone can answer. The word on a call and the second member for big amounts add friction.
- **Why can a Yes still be amber?** Gift cards, wires and crypto are hard to undo, so a Yes alone is not enough.
- **Where does the text go?** The server stores only a hash. If Gemini is on, the text is sent to Google's Gemini API for analysis. The optional call watcher uses the browser's speech service. See the README privacy section.
- **Is it push?** Live sockets plus browser notifications where allowed, not native push. Keep the tab open.
- **Does it work with no AI?** Yes. Everything works without Gemini.
- **Prize numbers or study results?** There is no study to quote. Say so.

## Numbers to cite (all "reported")

FTC 2025: imposter scams the most reported category, about $3.5B reported losses, nearly 1 in 3 fraud reports. TODO: confirm the exact source link before using it on Devpost or in the video.
