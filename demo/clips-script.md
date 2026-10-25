# Scammer clip lines

Five short lines for the soundboard (`web/dev/soundboard.js` expects these file names in `web/dev/audio/`). Keep each under about 8 seconds. Character: a scared grandchild on a bad phone line. The audio files are git-ignored; this text file is only the words.

Made with an ElevenLabs **stock voice** ("Liam", model `eleven_multilingual_v2`), not a clone, so no consent is needed. Each clip was transcribed back to check it says the right words. To regenerate or change the voice: `node demo/make-clips.mjs` (needs `ELEVENLABS_API_KEY` in `.env`; optional `CLIP_VOICE_ID`). A cloned voice would need the written consent in `demo/voice-consent.md` first. Plan B for every clip: Tejasv says the line live.

| File | Title on the soundboard | Line | When |
| --- | --- | --- | --- |
| `01-its-me.mp3` | It's me, I'm in trouble | "Grandma? It's me. I know this is a new number, my phone broke. I'm in trouble and I need your help." | Opens the call |
| `02-gift-cards.mp3` | Asks for gift cards | "I need two hundred dollars in Apple gift cards, right now. Please don't tell Mom, she'll be so upset." | Right after clip 1 |
| `03-dodge.mp3` | Dodges "What's our word?" | "There's no time for that, Grandma! My app crashed, I can't see it. Please, just do this for me." | Plays when the Victim asks for the word |
| `04-pressure.mp3` | Pushes: "please hurry" | "Please hurry, they're about to hang up on me. Just read me the numbers on the back of the cards." | If the word does not come |
| `05-hangup.mp3` | Gives up | "Fine. Forget it. I'll figure something out." | Optional closer |

Notes:
- The lines are deliberately short and generic. Do not add real names, real organizations or real brand claims.
- The word ("code word") is never said by the scammer, which is the point: they cannot.
- If a judge plays the soundboard, clips 3 and 4 are the ones to try.
