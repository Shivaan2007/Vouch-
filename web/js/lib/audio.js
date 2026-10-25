// Turns microphone samples into a small WAV the Vouch server can transcribe. Pure: no DOM, runs in browsers and Node.
import { bytesToB64 } from './canonical.js';

/**
 * Joins Float32 chunks, converts them to 16-bit mono at outRate by averaging, and reports how loud they were.
 * @param {Float32Array[]} chunks
 * @param {number} inRate sample rate of the microphone (often 44100 or 48000)
 * @param {number} [outRate] 16000 is plenty for speech
 * @returns {{pcm: Int16Array, rms: number}}
 */
export function toPcm16(chunks, inRate, outRate = 16000) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { flat.set(c, at); at += c.length; }
  const ratio = inRate / outRate;
  const n = Math.max(0, Math.floor(total / ratio));
  const pcm = new Int16Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(total, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += flat[j];
    const v = Math.max(-1, Math.min(1, sum / (b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    energy += v * v;
  }
  return { pcm, rms: n ? Math.sqrt(energy / n) : 0 };
}

/**
 * Wraps 16-bit mono PCM in a standard 44-byte WAV header.
 * @param {Int16Array} pcm
 * @param {number} [rate]
 * @returns {Uint8Array}
 */
export function wavBytes(pcm, rate = 16000) {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}

/**
 * Microphone chunks to a base64 WAV plus loudness, ready to send.
 * @param {Float32Array[]} chunks
 * @param {number} inRate
 * @returns {{wav: string, rms: number, seconds: number}}
 */
export function chunkToWav(chunks, inRate) {
  const { pcm, rms } = toPcm16(chunks, inRate);
  return { wav: bytesToB64(wavBytes(pcm)), rms, seconds: pcm.length / 16000 };
}
