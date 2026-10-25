# Vouch demo: "The Grandma call" (about 80 seconds)

**The rule:** everything on the phones is real (keys, pairing, signatures, verdicts). The only scripted thing is the scammer's voice. The two defences, the shared code word and the friend's signed Not me, are exactly what a real user would do.

Updated for `main` after PR #37 (Home screen, code word ring, spoken alerts). Lines marked **CONFIRM** are assumptions to settle at the first rehearsal.

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
| 10-35 s | **The call.** Tejasv phones the Victim's phone on speaker and says (or plays clips 1 and 2): "Grandma, it's me, new number, I need $200 in gift cards, don't tell Mom." The Victim opens **On a call**, taps **Show the word for Alex** (a ring counts the minute down), and asks "What's our word?". The caller dodges (clip 3). | Call is real; only the voice is scripted |
| 35-55 s | **The check.** The Victim taps **They're asking me for money**. The form opens set to Phone call. The Victim types `200`, picks **Gift cards**, taps **Ask Alex's phone**. Alex's phone speaks "Did you just ask Grandma for $200.00 via Gift cards?" Sayan taps **Not me**. The Victim's phone goes full-screen red, **STOP. Do not send money.**, and an ElevenLabs voice says it aloud. The Victim taps **I understand** (it unlocks after a few seconds). | All real |
| 55-70 s | **The contrast.** A real $20 Venmo request: the Victim opens **Check a message**, enters `20`, picks Venmo, taps **Ask Alex's phone**. Sayan taps **Yes, that was me**. The Victim's phone shows green **Verified. Safe to send.** and says it aloud. | All real |
| 70-80 s | **Close.** "Detecting fakes is a losing arms race. Vouch makes real people prove they're real." | Spoken |

Then invite the judge to play the scammer from the soundboard and try to talk their way past Vouch.

### Optional 15-second coda: "it is not only about money"

Scams do not always ask for money. After the close, or when a judge asks, the Victim opens **Check a message**, pastes a code request, and Vouch warns on the spot, with no friend check:

> Hi it's your bank. We sent a 6 digit code to your phone. Please read it to me to cancel the fraudulent login.

The screen goes red, **DO NOT ACT ON THIS**, with the guide "Asking for a code" and three plain steps. Other lines that work the same way: a remote-access ask (`Open TeamViewer and let me take control of your computer`), a password ask (`Please confirm your password and card details to keep your account active.`), an ID ask, or a fake delivery link. The friend check is for money requests only; say so if asked. These warnings work offline, and Gemini adds a plain explanation when it is on.

Why it works as a demo: the call beat shows the word that a scammer cannot know. The check beat shows the friend's signed answer. The contrast beat shows Vouch is not just "no".

## What is real in each beat

- The call is a real phone call. The phones, keys, pairing, signed answers and verdicts are real.
- The Not me or Yes comes from Alex's own phone, signed with a key that never leaves it. Both the server and the Victim's phone check the signature before showing green.
- The tags and the sentence under "AI check" come from rules, plus Gemini if a key is set. With Gemini off the verdict is the same, except that Gemini can make one more cautious (for example by spotting a gift card in a screenshot). AI never clears a request.
- A gift-card request never goes green on a Yes alone. That is why the contrast beat uses Venmo.
- ElevenLabs does three real jobs: it speaks the four fixed alerts (stop, wait, ok, call; only those phrases are ever sent, never a name or amount), it turns call audio and voice notes into words (Scribe), and it made the scammer voice. These were checked against the live service: the four alerts, a spoken verdict transcribed back word for word, and a scammer clip sent through the call listener to a STOP-level read. Not yet tried on a real phone.

## Cut list

- Message bot, call bot, Twilio, hotline: not in the demo. The family phone's alert is the real-world equivalent.
- The text-message beat: Q&A, or a 10-second coda if time allows. The Check screen has **Try an example** for it.
- Study numbers: no study has been run. Do not quote any numbers.
- Tier 3 (over $200, needs a second member): do not demo it.
- The judge typing on the phone: the Victim does it.
- **Listen for scams** (the call listener): optional bonus. Play clip 2 next to the Victim's phone while it listens and the warning should fire. On the server this works with the real ElevenLabs and Gemini; on a real phone it is untested, and phones often block the microphone during a real call.
- The 10-second pause before green ("Real friends can wait 10 seconds") is not built in the app. Do not mention it.

## Setup

Free hosting loses every pairing when it sleeps or redeploys, so run the demo from the laptop (see `server/DEPLOY.md`):

1. `node bot/serve.js` on the laptop (not `npm start`: only this loads `.env` for the spoken alerts, the AI read and call listening), then `cloudflared tunnel --url http://localhost:3000`. The `.env` needs `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. Open the printed https link on the Victim and Alex phones. Put the laptop and phones on a phone hotspot, not venue Wi-Fi. If the address changes (a tunnel restart, or a move to the Render link), every phone has to sign up and pair again, so settle the final address first.
2. Register the Victim as "Grandma" and Alex as "Alex", pair them, and read the safety code aloud to confirm it matches.
3. Both phones: Auto-Lock to Never, alerts on, volume up, Vouch tab open. Android phones vibrate on alerts; iPhones do not.
4. Copy the five clips from `demo/clips/` into `web/dev/audio/` on the demo laptop only (see the warning below), then open `/dev/soundboard.html` and play each once. On an iPhone, tap the screen once after opening Vouch so it lets the spoken alerts play.
5. Before every judge, reset the demo data (`/demo` page with `DEMO_KEY`, soft reset keeps the pairing).

**Warning on the audio files:** `web/dev/audio/` is not git-ignored and the server serves `web/` publicly. To keep the audio files out of the public repo, run `echo "web/dev/audio/" >> .git/info/exclude` on the demo laptop, keep the originals in `demo/clips/` (git-ignored), and never `git add -f`.

## Voice clips

The scammer clips are made with an ElevenLabs **stock voice** ("Liam"), not a clone of anyone, so no consent form is needed. Say in the demo that the voice is AI-generated. Regenerate or change the voice with `node demo/make-clips.mjs` (needs `ELEVENLABS_API_KEY`). Only if the team ever swaps in a cloned voice does the written consent in `demo/voice-consent.md` apply. The fallback is Tejasv saying the lines live. Lines: `demo/clips-script.md`.

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
| Spoken alert is silent or sounds like the phone's own voice | Expected when the server has no ElevenLabs key or voice ID, or the phone has not been tapped yet. The screen and the vibration still alert, so carry on |

## If a judge asks

- **Is this real or a mock?** Real keys, real signatures, real server. Only the scammer's voice is scripted.
- **What if the friend's phone is lost or stolen?** That is a limit: a thief with an unlocked phone can answer. The word on a call and the second member for big amounts add friction.
- **Why can a Yes still be amber?** Gift cards, wires and crypto are hard to undo, so a Yes alone is not enough.
- **Where does the text go?** The server stores only a hash. If Gemini is on, the text is sent to Google's Gemini API for analysis. With an ElevenLabs key, call audio and voice notes go to ElevenLabs to be turned into words, and the spoken alerts send only four fixed phrases. See the README privacy section.
- **Is it push?** Live sockets plus browser notifications where allowed, not native push. Keep the tab open.
- **Does it work with no AI?** Yes. Everything works without Gemini or ElevenLabs; alerts then use the phone's own voice.
- **Where does ElevenLabs come in?** It speaks the alerts, listens to calls and voice notes, and made the scammer voice. It never decides anything: a person's signed answer does.
- **Prize numbers or study results?** There is no study to quote. Say so.

## Our own checks (small, re-run on `main` after PR #43; do not call it a study)

- 36 fresh money-scam messages: the phone and server rules flagged 33 (27 got a specific warning tag); with Gemini on, 31 of 36 got the full STOP. 0 false alarms on 20 everyday messages.
- 8 scams that are not about money (code, remote access, password, ID, fake delivery link, job-ID, hacked-friend link, romance) plus 1 everyday message: Gemini gave 7 of the 8 a STOP-level read with a specific title, and the romance line (no ask yet) a caution. The offline rules on the phone caught the same 7 and not the romance line. The everyday message got "Nothing stands out".
- Say "our own small test, not a study", and never quote these as accuracy for real users. Known misses: an overpayment-refund scam and a "new payment portal, send rent to this Zelle number" scam, with no pressure words, can slip past the offline rules.

## Numbers to cite (all "reported")

FTC, March 2025: consumers reported losing more than $12.5 billion to fraud in 2024 (up 25%), and $2.95 billion of that was imposter scams. Source: https://www.ftc.gov/news-events/news/press-releases/2025/03/new-ftc-data-show-big-jump-reported-losses-fraud-125-billion-2024 . Reported losses only. Do not use the older "1 in 3" figure; it was not verified.
