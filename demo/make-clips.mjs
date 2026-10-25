// Makes the five scammer clips for the Grandma-call demo with ElevenLabs text to speech.
//   node demo/make-clips.mjs
// Needs ELEVENLABS_API_KEY in .env (never commit it). Optional: CLIP_VOICE_ID to use another voice.
// Default voice: ElevenLabs stock voice "Liam" (young, energetic). It is not a clone of anyone.
// The mp3 files go to demo/clips/ (git-ignored). Copy them to web/dev/audio/ on the demo laptop only.
// The lines are the same as in demo/clips-script.md; keep the two in step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* the real environment still applies */ }
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('Set ELEVENLABS_API_KEY in .env first.'); process.exit(1); }
const voice = process.env.CLIP_VOICE_ID || 'TX3LPaxmHKxFdv7VOQHJ';
const out = path.join(root, 'demo', 'clips');
fs.mkdirSync(out, { recursive: true });

const CLIPS = [
  ['01-its-me.mp3', "Grandma? It's me. I know this is a new number, my phone broke. I'm in trouble and I need your help."],
  ['02-gift-cards.mp3', "I need two hundred dollars in Apple gift cards, right now. Please don't tell Mom, she'll be so upset."],
  ['03-dodge.mp3', "There's no time for that, Grandma! My app crashed, I can't see it. Please, just do this for me."],
  ['04-pressure.mp3', "Please hurry, they're about to hang up on me. Just read me the numbers on the back of the cards."],
  ['05-hangup.mp3', "Fine. Forget it. I'll figure something out."],
];

let failed = 0;
for (const [file, text] of CLIPS) {
  let done = false;
  for (const model of ['eleven_multilingual_v2', 'eleven_flash_v2_5']) {
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.5 } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) { console.error(`${file}: ${model} answered ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      fs.writeFileSync(path.join(out, file), buf);
      console.log(`${file}  ${buf.length} bytes  (${model})`);
      done = true;
      break;
    } catch (e) { console.error(`${file}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); } // never print the key
  }
  if (!done) failed += 1;
}
console.log(failed ? `${failed} clip(s) failed` : `Done. Clips are in ${out}`);
process.exit(failed ? 1 : 0);
