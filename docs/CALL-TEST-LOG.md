# Live call test: what to measure, and where to write it down

Nobody has run Listen for scams on a real speakerphone call yet (the build machine has no microphone or speaker, so these cannot be filled in from a laptop).
Do this on two real phones once the deploy is confirmed. Fill in the table; do not round in our favour.

**Setup.** Phone A: Vouch open on **On a call**, **Listen for scams** tapped. Phone B: places a normal call to a third phone C, or plays a clip through its speaker. Put C on speaker next to A. Use `?aloud=1` on A's address if the demo wants spoken warnings.

Run each scene from `docs/LIVE-CALL-SCENES.md`, in a quiet room and then in a noisy one (a fan, a busy corridor).

| Run | Room | Engine on A (browser or Vouch server) | Time from the caller saying the code request to the red screen (s) | Time to first "Noticing" (s) | Words missed or wrong (examples) | Heard both voices? | Echo or feedback? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Family call | quiet | | | | | | | |
| Family call | noisy | | | | | | | |
| Bank call | quiet | | | | | | | |
| Bank call | noisy | | | | | | | |
| Genuine control | quiet | | | | | | | must stay calm |

What to expect (from the code, not measured on a phone): the browser's speech recognition shows words almost at once; the server path sends audio in 5-second slices, so add up to 5 s plus the transcription time; the AI read is asked at most every 4 s and took 1 to 6 s in the desktop test; the offline call engine reacts the instant the words arrive. A phone that blocks the microphone during a call needs the second-phone or typed fallback.

Record the phone models, browsers and the network too; they change the numbers.

## Measured so far: the whole pipeline on a laptop (NOT a phone, NOT a speakerphone)

A spoken First Harbor Bank call (the Windows "David" voice, 39 s, 5 lines, 1.2 s pauses) was played into real Chrome at phone size as its microphone (`--use-file-for-fake-audio-capture`), on the iPhone path (the Vouch server's speech-to-text, Gemini), against the real server. Times are seconds after tapping **Listen for scams**; this is what appeared on screen.

| What | Measured |
| --- | --- |
| First words on screen | about 9 s (includes 2 s of silence at the start of the clip, one 4 s slice, and about 2 to 3 s of transcription) |
| Captions after that | a new piece every 3 to 5 s, each roughly 4 to 6 s behind the speech |
| "Noticing something" | 15 s, after the caller said they were from First Harbor Bank's security team |
| "STOP. This looks like a scam" | 18 s in one run (22 to 24 s in two others), after "unusual activity on your account" plus the bank claim; Gemini's judgement varies slightly from run to run |
| Why-ladder ticks | as each step is heard (bank claim, then "move your funds to a safe account", then the code request) |
| Transcript accuracy | good, with small slips ("Dan" for "Daniel", "maybe compromised" for "may be compromised"); one run with 3 s slices repeated words and dropped a line, so slices are 4 s |

What this does and does not show: it shows the whole chain works on real audio (microphone, slicing, speech-to-text, the call engine, the AI read, the screen). It does not show echo, room noise, a phone speaker, a phone's microphone, or both sides of a real call. Use the table above on real phones for those. The browser's own speech recognition (Android Chrome, desktop) shows words almost immediately; it could not be tested here.
