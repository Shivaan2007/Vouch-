# Live call demo: plan, scripts and test checklist

Owner: Tejasv (story and scripts). Shivaan: deploy and Grandma's phone. Sayan: Listen-for-scams test and timing.
This sits beside `docs/DEMO.md` (the 80-second story) and `docs/JUDGE-PLAYBOOK.md` (what judges try). It adds the two real phone calls.

## What we show (about 3 minutes)

Vouch is two-factor authentication for people. It protects in two ways: a real friend's phone confirms who is really asking, and Vouch warns when a stranger or an organisation asks for something dangerous.

| # | Beat | Time | What happens |
| --- | --- | --- | --- |
| 1 | Hook | 10 s | "AI can clone a voice, so a voice proves nothing. Vouch proves the person." |
| 2 | **Call 1: the code word** | 60 s | A fake grandchild phones Grandma and asks for gift cards. Grandma opens **On a call**, picks Alex, asks "What's our word?", types what the caller says. The caller dodges or is wrong: **no match**. Optional: she taps **Check with Alex's phone**, Alex taps **Not me**, red **STOP**. |
| 3 | Contrast | 15 s | The real Alex says the right word: **match**. A $20 Venmo check, Alex taps **Yes**, green. |
| 4 | **Call 2: the bank scam** | 45 s | A calm "First Harbor Bank" caller. Grandma taps **Listen for scams** with the call on speaker. Vouch warns at the code request. |
| 5 | Judge picks | 60 s | The judge pastes or types any scam from the cards. One card is harmless: no false alarm. |

Close: "Detecting fakes is a losing arms race. Vouch makes real people prove they're real."

**Fallback:** if Call 2 is not reliable on speakerphone in two rehearsals, paste the bank text into **Check a message**. Same point, no microphone risk.

## Call 1: the code word (scripted voice, real app)

Caller (Tejasv or clip): 
1. "Grandma? It's me. New number, my phone broke. I'm in trouble."
2. "I need two hundred dollars in Apple gift cards right now. Please don't tell Mom."
3. When asked for the word: "There's no time for that, Grandma, please hurry." (a dodge), or a wrong word such as "pineapple".

Grandma: **On a call**, tap Alex, say "What's our word?", type the caller's answer. Vouch shows no match. 
Real Alex (Sayan) in the contrast beat reads the true word from his own phone: match.

The app does not hear the word by itself. A person types it and Vouch compares it with the word both phones compute. Say that out loud.

## Call 2: the bank scam (fictional bank, calm voice)

The danger comes from the request, not from a menacing voice. Fictional bank, account and code only; no real brand.

Caller lines, in order:
1. "Hello, this is the fraud department at First Harbor Bank. Am I speaking with Mr. Lee?"
2. "We noticed a payment of four hundred and eighty dollars that you may not recognise. I'd like to help you cancel it."
3. "To cancel it I just need the six digit code we texted you. Please read it to me."
4. "Please stay on the line. The payment goes through in two minutes."

Expected Vouch behaviour (tested on the phone's rules): lines 1 to 2 stay quiet or a caution; **line 3 turns it red** with "They asked you to read out a code. Real banks never do this." and three steps (do not read it out, hang up, call the number on your card).

Variants that also reach STOP: card number and the three digits on the back plus "don't hang up"; "move your savings to a safe account"; gift cards for a "fine".

**Harmless control call (must stay quiet):** "Hello, this is First Harbor Bank confirming your appointment tomorrow at three. This is an appointment reminder. We will never ask for your PIN or your password. Press 1 to confirm."

## Judge-picks cards (beat 5)

Fictional, no real logos, no live links: bank text asking for the code; "parcel on hold" with a lookalike link; "confirm your password" email; a hacked friend's "is this you in this video?" link; an ID-photo request; one harmless message ("dinner at 7?").

## Setup checklist (before every judge)

- [ ] One final Render address. Pair the three phones **after the last deploy**; a redeploy wipes pairings.
- [ ] Pinger on `/health` so the free plan does not sleep.
- [ ] **Display, "Speak warnings aloud" ON** on every phone (voice is off by default).
- [ ] Volume up, silent switch off, Auto-Lock never, Vouch tab open.
- [ ] Hotspot or venue Wi-Fi tested; fall back to cellular.
- [ ] Clips in `web/dev/audio/` (never committed). Soundboard open.
- [ ] Phones: Judge (spare), Alex (Sayan), Grandma (Shivaan).

## Live phone test (do together once the deploy is confirmed)

| Check | Pass when |
| --- | --- |
| iPhone sound | The spoken warning plays after one tap |
| Camera pairing | The QR scans; the safety codes match |
| Network | Works on hotspot and venue Wi-Fi |
| Code word | Right word = match; wrong or dodge = no match |
| Listen for scams | Red within a few seconds of line 3; **write down the seconds** (Sayan) |
| Harmless call | Stays quiet |
| Noise and echo | Both voices are picked up on speakerphone |
| Reset | Soft reset (`/demo`, keep friends) leaves the phones paired |

## Honest limits (say them first)
- Live call listening is untested on many real phones; some block the microphone during a call.
- The code word is compared by a person typing it.
- Our checks are small tests, not a study. Do not quote accuracy.
- Telegram Business in the judge script needs Telegram Premium on Grandma's account.

## Finish order
1. Shivaan confirms the final deploy and pinger. 2. Pair phones. 3. Live phone test above. 4. Two timed rehearsals and a backup recording. 5. Devpost screenshots, thumbnail, video. 6. Freeze at 10 AM (Auto-Deploy off, no merges). 7. Submit before noon.
