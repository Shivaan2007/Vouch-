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
