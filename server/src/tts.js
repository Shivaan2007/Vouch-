// Spoken alerts through ElevenLabs. Only FIXED phrases are ever sent: no message text, name or amount leaves the server.
// The audio is made once per phrase and kept in memory. Without a key, or on any failure, the route answers 503/502
// and the phone falls back to its built-in voice, so this can never break a check.
export const PHRASES = {
  stop: 'Stop. Do not send money. This request could be a scam.',
  wait: 'Wait. Do not send money yet. Check again with your friend.',
  ok: 'Verified. Your friend confirmed this on their own phone.',
  call: 'Warning. This call may be a scam. Do not send money.',
};

const DEFAULT_MODEL = 'eleven_flash_v2_5';
const FORMAT = 'mp3_44100_128';
const TIMEOUT_MS = 5000;

// Values pasted into a dashboard often carry a trailing space or newline, or surrounding quotes. Any of those breaks the request.
const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

export function createTts({
  apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID,
  model = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  cooldownMs = 30000,
  timeoutMs = TIMEOUT_MS,
  log = () => {},
} = {}) {
  apiKey = clean(apiKey);
  voiceId = clean(voiceId);
  model = clean(model) || DEFAULT_MODEL;
  const cache = new Map();     // phrase id -> Buffer
  const inflight = new Map();  // phrase id -> Promise<Buffer>
  let failedAt = 0;
  let lastReason = '';
  const enabled = () => !!(apiKey && voiceId);

  async function generate(id) {
    const res = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${FORMAT}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: PHRASES[id], model_id: model }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) {
      let code = '';
      try { const j = await res.json(); code = String(j?.detail?.status || j?.detail?.code || j?.status || '').slice(0, 60); } catch { /* not JSON */ }
      throw new Error(`ElevenLabs answered ${res.status}${code ? ` (${code})` : ''}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('ElevenLabs returned no audio');
    return audio;
  }

  // -> { status: 200, audio } | { status: 404|502|503, error }
  async function get(id) {
    if (!Object.hasOwn(PHRASES, id)) return { status: 404, error: 'UNKNOWN_PHRASE' };
    if (!enabled()) return { status: 503, error: 'TTS_OFF' };
    if (cache.has(id)) return { status: 200, audio: cache.get(id) };
    if (failedAt && Date.now() - failedAt < cooldownMs) return { status: 503, error: 'TTS_COOLING_DOWN', detail: lastReason }; // do not hammer a failing service
    if (!inflight.has(id)) {
      inflight.set(id, generate(id).then((a) => { cache.set(id, a); return a; }).finally(() => inflight.delete(id)));
    }
    try {
      return { status: 200, audio: await inflight.get(id) };
    } catch (e) {
      failedAt = Date.now();
      lastReason = e.name === 'TimeoutError' ? 'timeout' : e.message; // a status code or a short code from ElevenLabs; never the key or the URL
      log(`tts failed: ${lastReason}`);
      return { status: 502, error: 'TTS_FAILED', detail: lastReason };
    }
  }

  return { get, enabled, cachedCount: () => cache.size };
}
