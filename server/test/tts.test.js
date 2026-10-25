import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { PHRASES } from '../src/tts.js';

const KEY = 'sk_test_THIS_IS_A_FAKE_KEY_FOR_TESTS';
const VOICE = 'voice123';
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3, 4]); // pretend mp3 bytes

// A fake ElevenLabs. Records every call; `behave` decides the answer.
function fakeEleven(behave = () => new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } })) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return behave(calls.length); };
  return { calls, fetchImpl };
}
const withTts = (extra = {}, opts = {}) => startServer({ ttsOptions: { apiKey: KEY, voiceId: VOICE, ...extra }, ...opts });
const get = (t, path) => fetch(`${t.url}${path}`);

test('no key: 503 TTS_OFF, so the phone uses its own voice', async () => {
  const t = await startServer({ ttsOptions: { apiKey: '', voiceId: '' } });
  try {
    const r = await get(t, '/tts/stop');
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: 'TTS_OFF' });
  } finally { await t.stop(); }
});

test('a key without a voice id is also off', async () => {
  const t = await startServer({ ttsOptions: { apiKey: KEY, voiceId: '' } });
  try { assert.equal((await get(t, '/tts/stop')).status, 503); } finally { await t.stop(); }
});

test('only the fixed phrases exist; unknown or odd ids never reach ElevenLabs', async () => {
  const fake = fakeEleven();
  const t = await withTts({ fetchImpl: fake.fetchImpl });
  try {
    for (const id of ['nope', 'STOP', '..%2Fstop', 'stop%20now', 'constructor', '__proto__', 'toString', '']) {
      const r = await get(t, `/tts/${id}`);
      assert.ok([404].includes(r.status), `${id} -> ${r.status}`);
    }
    assert.equal(fake.calls.length, 0);
    // the route takes no text: a query string cannot change what is spoken
    assert.equal((await get(t, '/tts/stop?text=send%20me%20your%20password')).status, 200);
    assert.equal(fake.calls[0].body.text, PHRASES.stop);
  } finally { await t.stop(); }
});

test('sends exactly the fixed phrase with the key in a header, and returns audio', async () => {
  const fake = fakeEleven();
  const t = await withTts({ fetchImpl: fake.fetchImpl, model: 'test-model' });
  try {
    const r = await get(t, '/tts/ok');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(AUDIO));
    const [c] = fake.calls;
    assert.equal(c.url, `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`);
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers['xi-api-key'], KEY);
    assert.deepEqual(c.body, { text: PHRASES.ok, model_id: 'test-model' });
    assert.ok(!c.url.includes(KEY), 'the key must never be in the URL');
  } finally { await t.stop(); }
});

test('made once, then served from memory; parallel requests share one call', async () => {
  const fake = fakeEleven();
  const t = await withTts({ fetchImpl: fake.fetchImpl });
  try {
    const [a, b, c] = await Promise.all(['stop', 'stop', 'stop'].map((id) => get(t, `/tts/${id}`)));
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.equal(fake.calls.length, 1);
    await get(t, '/tts/stop'); await get(t, '/tts/stop');
    assert.equal(fake.calls.length, 1);
    await get(t, '/tts/wait');
    assert.equal(fake.calls.length, 2);   // a different phrase is its own call; at most 4 calls exist, ever
  } finally { await t.stop(); }
});

test('ElevenLabs error -> 502, nothing cached, and it backs off instead of hammering', async () => {
  const fake = fakeEleven((n) => (n === 1 ? new Response('quota exceeded', { status: 401 }) : new Response(AUDIO, { status: 200 })));
  const logs = [];
  const t = await withTts({ fetchImpl: fake.fetchImpl, cooldownMs: 60000, log: (m) => logs.push(m) });
  try {
    const first = await get(t, '/tts/stop');
    assert.equal(first.status, 502);
    assert.equal((await first.json()).error, 'TTS_FAILED');
    const second = await get(t, '/tts/stop');            // inside the cool-down: no new call
    assert.equal(second.status, 503);
    assert.equal(fake.calls.length, 1);
    assert.ok(logs.some((l) => l.includes('401')) && logs.every((l) => !l.includes(KEY)), 'logs say what failed, never the key');
  } finally { await t.stop(); }
});

test('after the cool-down it tries again and recovers', async () => {
  const fake = fakeEleven((n) => (n === 1 ? new Response('boom', { status: 500 }) : new Response(AUDIO, { status: 200 })));
  const t = await withTts({ fetchImpl: fake.fetchImpl, cooldownMs: 0 });
  try {
    assert.equal((await get(t, '/tts/stop')).status, 502);
    assert.equal((await get(t, '/tts/stop')).status, 200);
    assert.equal(fake.calls.length, 2);
  } finally { await t.stop(); }
});

test('a hung ElevenLabs times out instead of hanging the phone', async () => {
  const fetchImpl = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  const logs = [];
  const t = await withTts({ fetchImpl, timeoutMs: 150, log: (m) => logs.push(m) });
  try {
    const started = Date.now();
    const r = await get(t, '/tts/stop');
    assert.equal(r.status, 502);
    assert.ok(Date.now() - started < 3000);
    assert.ok(logs.some((l) => l.includes('timeout')));
  } finally { await t.stop(); }
});

test('empty audio is treated as a failure, not cached', async () => {
  const fake = fakeEleven(() => new Response(new Uint8Array(0), { status: 200 }));
  const t = await withTts({ fetchImpl: fake.fetchImpl, cooldownMs: 0 });
  try {
    assert.equal((await get(t, '/tts/stop')).status, 502);
    assert.equal((await get(t, '/tts/stop')).status, 502);
    assert.equal(fake.calls.length, 2);
  } finally { await t.stop(); }
});

test('the key never appears in any response, and /demo/status reports on/off without it', async () => {
  const fake = fakeEleven();
  const t = await withTts({ fetchImpl: fake.fetchImpl }, { demoKey: 'demo-key-for-tts-test' });
  try {
    const audio = await get(t, '/tts/stop');
    assert.ok(![...audio.headers.values()].join('\n').includes(KEY));
    const st = await fetch(`${t.url}/demo/status`, { headers: { 'x-demo-key': 'demo-key-for-tts-test' } });
    const body = await st.text();
    assert.match(body, /"tts":"on \(1 of 4 phrases cached\)"/);
    assert.ok(!body.includes(KEY) && !body.includes(VOICE));
  } finally { await t.stop(); }
});

test('POST and other methods are not accepted on the phrase route', async () => {
  const t = await withTts({ fetchImpl: fakeEleven().fetchImpl });
  try {
    const r = await fetch(`${t.url}/tts/stop`, { method: 'POST', body: JSON.stringify({ text: 'say something else' }) });
    assert.notEqual(r.status, 200);
  } finally { await t.stop(); }
});

test('a key or voice id pasted with spaces, a newline or quotes still works', async () => {
  const fake = fakeEleven();
  const t = await startServer({ ttsOptions: { apiKey: `  "${KEY}"\n`, voiceId: ` '${VOICE}' `, fetchImpl: fake.fetchImpl } });
  try {
    assert.equal((await get(t, '/tts/stop')).status, 200);
    assert.equal(fake.calls[0].init.headers['xi-api-key'], KEY);
    assert.ok(fake.calls[0].url.includes(`/text-to-speech/${VOICE}?`));
  } finally { await t.stop(); }
});

test('a failure says why (status and ElevenLabs code), never the key', async () => {
  const body = JSON.stringify({ detail: { status: 'invalid_api_key', message: `your key ${KEY} is bad` } });
  const fake = fakeEleven(() => new Response(body, { status: 401 }));
  const t = await withTts({ fetchImpl: fake.fetchImpl, cooldownMs: 60000 });
  try {
    const first = await (await get(t, '/tts/stop')).json();
    assert.equal(first.error, 'TTS_FAILED');
    assert.equal(first.detail, 'ElevenLabs answered 401 (invalid_api_key)');
    const second = await (await get(t, '/tts/stop')).json();
    assert.equal(second.error, 'TTS_COOLING_DOWN');
    assert.equal(second.detail, first.detail);
    assert.ok(!JSON.stringify([first, second]).includes(KEY));
  } finally { await t.stop(); }
});
