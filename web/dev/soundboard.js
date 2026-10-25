// Demo soundboard for the call: plays the pre-generated "scammer" voice clips.
// Drop the mp3 files in web/dev/audio/ with these names (or edit the list). Missing files are reported, not hidden.
const CLIPS = [
  { file: 'audio/01-its-me.mp3', title: '1. "It\'s me, I\'m in trouble"', note: 'Opens the call: new number, urgent, scared.' },
  { file: 'audio/02-gift-cards.mp3', title: '2. Asks for gift cards', note: 'Needs $200 in Apple gift cards, "don\'t tell mom".' },
  { file: 'audio/03-dodge.mp3', title: '3. Dodges "What\'s our word?"', note: 'Plays right after the victim asks for the word.' },
  { file: 'audio/04-pressure.mp3', title: '4. Pushes: "please hurry"', note: 'Pressure when the word does not come.' },
  { file: 'audio/05-hangup.mp3', title: '5. Gives up', note: 'Optional closer.' },
];

const list = document.getElementById('list');
let current = null;

function stopAll() {
  if (current) { current.audio.pause(); current.audio.currentTime = 0; current.btn.classList.remove('playing'); current = null; }
}

for (const clip of CLIPS) {
  const audio = new Audio(clip.file);
  audio.preload = 'auto';
  const btn = document.createElement('button');
  const title = document.createElement('span');
  title.textContent = clip.title;
  const note = document.createElement('small');
  note.textContent = clip.note;
  btn.append(title, note);
  const miss = document.createElement('p');
  miss.className = 'miss';
  miss.hidden = true;
  miss.textContent = `Missing: web/dev/${clip.file}. Generate it in ElevenLabs and add it.`;
  audio.addEventListener('error', () => { miss.hidden = false; });
  audio.addEventListener('ended', () => { btn.classList.remove('playing'); if (current && current.audio === audio) current = null; });
  btn.addEventListener('click', () => {
    stopAll();
    miss.hidden = true;
    current = { audio, btn };
    btn.classList.add('playing');
    audio.play().catch(() => { miss.hidden = false; btn.classList.remove('playing'); current = null; });
  });
  list.append(btn, miss);
}
document.getElementById('stop').addEventListener('click', stopAll);
