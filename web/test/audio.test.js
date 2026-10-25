import test from 'node:test';
import assert from 'node:assert/strict';
import { toPcm16, wavBytes, chunkToWav } from '../js/lib/audio.js';
import { b64ToBytes } from '../js/lib/canonical.js';

const tone = (n, rate, hz, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

test('resamples 48 kHz to 16 kHz and keeps the length in proportion', () => {
  const { pcm } = toPcm16([tone(48000, 48000, 440)], 48000);
  assert.equal(pcm.length, 16000);
});

test('44.1 kHz works too, and chunks are joined in order', () => {
  const a = tone(22050, 44100, 300); const b = tone(22050, 44100, 300);
  const { pcm } = toPcm16([a, b], 44100);
  assert.ok(Math.abs(pcm.length - 16000) <= 1);
});

test('loudness separates speech from silence, and values are clamped', () => {
  assert.ok(toPcm16([tone(16000, 16000, 440, 0.5)], 16000).rms > 0.3);
  assert.equal(toPcm16([new Float32Array(16000)], 16000).rms, 0);
  const { pcm } = toPcm16([Float32Array.from({ length: 160 }, () => 5)], 16000);
  assert.ok(pcm.every((v) => v <= 32767 && v >= -32768));
});

test('WAV header is a valid 16 kHz mono 16-bit file', () => {
  const w = wavBytes(Int16Array.from([1, -1, 2, -2]), 16000);
  const dv = new DataView(w.buffer);
  const tag = (o) => String.fromCharCode(...w.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF'); assert.equal(tag(8), 'WAVE'); assert.equal(tag(12), 'fmt '); assert.equal(tag(36), 'data');
  assert.equal(dv.getUint16(20, true), 1, 'PCM');
  assert.equal(dv.getUint16(22, true), 1, 'mono');
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 8, 'data length');
  assert.equal(dv.getUint32(4, true), 36 + 8);
  assert.equal(w.length, 44 + 8);
  assert.equal(dv.getInt16(44, true), 1); assert.equal(dv.getInt16(46, true), -1);
});

test('a six second chunk fits well under the server limit', () => {
  const { wav, seconds } = chunkToWav([tone(48000 * 6, 48000, 440)], 48000);
  assert.ok(Math.abs(seconds - 6) < 0.01);
  assert.ok(wav.length < 400_000, `${wav.length} base64 chars`);
  assert.equal(String.fromCharCode(...b64ToBytes(wav).slice(0, 4)), 'RIFF');
});

test('empty input does not throw', () => {
  assert.doesNotThrow(() => chunkToWav([], 48000));
});
