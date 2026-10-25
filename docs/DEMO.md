# Vouch demo (90 seconds)

Skeleton. Fill the TODOs after the 10 AM feature freeze and after the first rehearsal. Do not state anything below as fact until it has been run on the real phones.

## Roles

| Person | Does |
| --- | --- |
| C (Tejasv) | Presents. Places the call, plays the clip, talks to the judge. |
| B (Sayan) | Holds the friend's phone: taps Not me. |
| A (Shivaan) | Runs the hotspot, plays clips, watches server logs, resets demo data. |

## Before every judge

- [ ] Warm the server (open the URL, wait for the page). Free hosting sleeps.
- [ ] Phones on the phone hotspot, not venue Wi-Fi. Auto-Lock set to Never. Vouch tab open on every phone.
- [ ] Reset the demo circle (A). Re-pair phones if the database was wiped by a deploy.
- [ ] Demo clips in `demo/clips/` (gitignored) tested with sound. TODO: stock-voice fallback ready.
- [ ] Cloned voice only with the speaker's written consent. Say it is a consented cloned voice. TODO: check ElevenLabs voice-cloning terms.
- [ ] Judge asked first before any call. Otherwise hand them a spare phone.
- [ ] Gemini on. Know the plan for Gemini off: the verdict is identical, only the explanation sentence is plainer.

## Script

| Time | Beat | What happens | Say (TODO: finalize wording) |
| --- | --- | --- | --- |
| 0-10 s | Hook | Title slide or phone in hand. | Nearly 1 in 3 fraud reports (FTC, 2025, reported) were imposter scams, and AI can clone anyone's voice. |
| 10-45 s | The call | C calls a consenting judge and plays the cloned clip. Judge asks "What's our word?". The clip stalls. Judge types any word into Check a word and it fails. B's phone answers Not me. Circle alert fires on a third phone. | TODO |
| 45-65 s | The text | Screenshot of "new number, venmo me $60". Tags appear, pause, verdict. | TODO |
| 65-80 s | Proof | Study numbers. Report the real n and the small-sample caveat. | TODO after the study |
| 80-90 s | Close | "Detecting fakes is a losing arms race. Vouch makes real people prove they're real." | Same. |

Live-call truth to say if asked: demo uses open sockets, not real push, so the Vouch tab stays open.

## FNB mapping (use their words)

- Information: a money request arrives (text or call)
- Understanding: the AI names the tactic in plain words
- Confidence: the rotating word matches, or a signed answer from their real phone
- Action: a clear verdict with one next step, plus an automatic circle alert

## If something breaks

| Problem | Do |
| --- | --- |
| Server asleep or slow | Reload, wait for it, keep talking over the problem slide. TODO: backup video ready. |
| Gemini slow | Nothing. 3 s timeout, rules-only result, same verdict. |
| Pairing lost | Re-pair on the spot. TODO: time it. |
| Clip fails | Use the stock-voice clip or read the line aloud. |

## Numbers to cite (all "reported")

FTC 2025: imposter scams most reported category, about $3.5B reported losses, nearly 1 in 3 fraud reports. Total reported fraud about $16B. TODO: add exact source links before putting them on Devpost.
