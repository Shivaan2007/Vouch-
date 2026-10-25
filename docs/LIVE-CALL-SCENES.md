# The two live calls (for the video and for judges)

Both calls are played to the Vouch app as a real call on speaker (a person, or Tejasv's ElevenLabs clips from `demo/`). The "Victim" phone has Vouch
open on **On a call** with **Listen for scams** already tapped. No keyword is hard-coded for these scenes: what you see is the call engine
(the shape of a scam script over time) plus the AI read.

Measured on the real detection (call engine + Gemini), cumulative transcript after each line. "Rules" is the offline engine; "AI" is the Gemini read.
Timings vary with the network; the first AI read of a call is the slowest (up to ~6 s), the rest are 1 to 3 s. Re-run if you change a line.

## Scene A: the "grandson" (no scam words at all)
Caller (a person or a clip). Fictional family, consenting voices only.

| # | Caller says | What the app shows (measured) |
| --- | --- | --- |
| 1 | "Hi Grandma, it's me." | Listening. Nothing yet. |
| 2 | "I know it's late, I'm so sorry. My phone broke so I'm calling from a friend's." | **Noticing something. Be careful.** (AI: medium, "grandchild in trouble") and the **code word appears** |
| 3 | "I got into a bit of trouble and I really need your help tonight." | Still noticing; the AI read is confident by here or the next line |
| 4 | "Please don't tell Mom or Dad, they'll freak out." | **STOP. This looks like a scam.** The ladder ticks: says they're family, rushing you, asking you to keep quiet |
| 5 | "I need eight hundred dollars for a lawyer before the morning. Can you help me?" | STOP stays; the engine adds "asked for money" |

**The moment for the camera:** after line 2 the code word is on screen. Grandma says: *"What's our word?"* The caller cannot answer. She taps **It doesn't match**.
Then, with the real grandson: Alex's phone is asked *"Did you just ask Grandma for $800?"* and taps **Not me**: Grandma's phone shows the full-screen STOP.

## Scene B: the bank (all soft hints; "First Harbor Bank" is fictional)

| # | Caller says | What the app shows (measured) |
| --- | --- | --- |
| 1 | "Good afternoon, this is Daniel from First Harbor Bank's security team." | AI: *noticing* ("fake bank call", medium) |
| 2 | "We've noticed some unusual activity on your account and want to make sure it's secured." | Noticing |
| 3 | "For your protection I'll need to verify a few details first. Can you confirm your date of birth?" | **STOP.** Authority + a request for personal details + pressure. AI is also high |
| 4 | "We've detected that your account may be compromised, so we'll need to move your funds to a protected account right away." | STOP (a red line: move your money to a "safe" account) |
| 5 | "I'll send you a code by text. Please read it back to me so I can lock things down." | STOP (a red line: read out a code) |

**What to say over it:** "Nothing here is a banned word. It noticed on the first line because of how the call is built, and it was sure by the third. A real bank never asks you to read a code or move your money."

## A genuine call (shows it does not cry wolf)
- Doctor's office: "Hi, it's Dr Lee's office. I'm calling to confirm your appointment on Tuesday at three." Then: "Please bring your insurance card." Result: **nothing stands out.**
- A friend: "Running ten minutes late. Can you grab me a coffee, I'll pay you back." Result: at most **Check** ("someone is asking for money"), never STOP.

## Setting it up for filming
1. Display (the **Aa** button): leave **Speak warnings aloud** OFF for judges. For the video phones only, switch it ON if the script wants the voice.
2. Grandma's phone: sign up, pair with Alex (compare the safety code), open **On a call**, pick Alex, tap **Listen for scams**. Phone on speaker at normal volume, mic towards the speaker.
3. Wifi: if the venue blocks the link, use cellular. Check the AI is on (the server prints "Call listening: on").
4. Try each scene once before filming. If the first line's AI read is slow, start the call two seconds before the first line.

## Honest limits
- A phone's microphone has to *hear* the call (speaker). A native app would not need that; that is the next step.
- Speech-to-text mishears words now and then. The engine is built for that (a soft signal has to hold for a moment before it becomes STOP), and the AI read sees the whole conversation.
- The percentages of how often it is right are not measured. These scenes are examples we tried, not a benchmark.
