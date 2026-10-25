// ElevenLabs for Vouch Watch: the ears and the voice.
//   transcribe(): Scribe turns a voice note or a slice of a phone call into words (the AI then judges the words).
//   speak():      reads Vouch's plain-words verdict aloud, so someone who would rather listen than read still gets it.
// Optional: with no ELEVENLABS_API_KEY everything here returns null and the callers fall back (Gemini hears the audio; text only).
// Nothing is stored. The audio and the words are never logged.

const API = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // ElevenLabs' stock "Sarah": calm and clear. Override with ELEVENLABS_VOICE_ID.

/** @param {{apiKey?: string, voiceId?: string, fetchImpl?: typeof fetch}} [opts] */
export function createVoice({ apiKey = '', voiceId = '', fetchImpl = globalThis.fetch } = {}) {
  const enabled = !!(apiKey && typeof fetchImpl === 'function');

  /** @returns {Promise<string|null>} the words, '' for silence, or null when Scribe could not be used */
  async function transcribe(audio, mime = 'audio/wav') {
    if (!enabled || !audio || !audio.length) return null;
    try {
      const form = new FormData();
      form.append('model_id', 'scribe_v1');
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([audio], { type: mime }), mime.includes('ogg') ? 'voice.ogg' : 'audio.wav');
      const res = await fetchImpl(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(12000) });
      if (!res || !res.ok) return null;
      const body = await res.json();
      return typeof (body && body.text) === 'string' ? body.text.trim().slice(0, 1500) : null;
    } catch { return null; }
  }

  /** @returns {Promise<Buffer|null>} an mp3, or null */
  async function speak(text) {
    const say = String(text || '').trim().slice(0, 600);
    if (!enabled || !say) return null;
    try {
      const res = await fetchImpl(`${API}/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_VOICE)}?output_format=mp3_44100_64`, {
        method: 'POST', headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: say, model_id: 'eleven_flash_v2_5' }), signal: AbortSignal.timeout(12000),
      });
      if (!res || !res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 0 ? buf : null;
    } catch { return null; }
  }

  return { enabled, transcribe, speak };
}

/** The short spoken version of a verdict: the headline and the first thing to do, nothing a listener has to scroll for. */
export function spokenVerdict(a) {
  if (!a || a.level < 1) return 'Nothing stands out in that. If it asks for money, still check with the person on a number you know.';
  const g = a.guide || {};
  const first = (g.steps && g.steps[0]) || 'Do not send anything yet.';
  return `${a.level === 2 ? 'Stop. This looks like a scam.' : 'Be careful.'} ${g.title || ''}. ${first}`.replace(/\s+/g, ' ').trim();
}
