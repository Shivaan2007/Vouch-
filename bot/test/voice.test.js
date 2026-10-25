import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice, spokenVerdict } from '../voice.js';
import { createBot } from '../telegram-bot.js';

const ok = (obj) => ({ ok: true, json: async () => obj, arrayBuffer: async () => Buffer.from('mp3-bytes') });
const quiet = { analyze: async () => ({ tags: [], paymentRisk: 'low', explanation: '' }) };

test('without a key the voice module does nothing and says so by returning null', async () => {
  const v = createVoice({ apiKey: '', fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(v.enabled, false);
  assert.equal(await v.transcribe(Buffer.from('x')), null);
  assert.equal(await v.speak('hello'), null);
});

test('Scribe gets the audio with the key in a header, and a bad answer is null, never a throw', async () => {
  let seen;
  const v = createVoice({ apiKey: 'KEY', fetchImpl: async (url, init) => { seen = { url: String(url), key: init.headers['xi-api-key'], hasFile: init.body.has('file'), model: init.body.get('model_id') }; return ok({ text: ' hello there ' }); } });
  assert.equal(await v.transcribe(Buffer.from('abc'), 'audio/ogg'), 'hello there');
  assert.deepEqual(seen, { url: 'https://api.elevenlabs.io/v1/speech-to-text', key: 'KEY', hasFile: true, model: 'scribe_v1' });
  assert.equal(await createVoice({ apiKey: 'K', fetchImpl: async () => ({ ok: false }) }).transcribe(Buffer.from('abc')), null);
  assert.equal(await createVoice({ apiKey: 'K', fetchImpl: async () => { throw new Error('down'); } }).speak('hi'), null);
});

test('the spoken verdict is short: the headline and the first thing to do', () => {
  assert.equal(spokenVerdict({ level: 2, guide: { title: 'Gift card payment scam', steps: ['Do not buy any cards.', 'Hang up.'] } }), 'Stop. This looks like a scam. Gift card payment scam. Do not buy any cards.');
  assert.match(spokenVerdict({ level: 0 }), /Nothing stands out/);
});

function harness({ voice, infer }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/file/bot')) return ok({});
    if (u.includes('elevenlabs.io')) return u.includes('speech-to-text') ? ok({ text: 'buy apple gift cards and read me the numbers' }) : ok({});
    if (u.endsWith('/getFile')) return ok({ ok: true, result: { file_path: 'voice/v1.oga' } });
    if (u.endsWith('/sendVoice')) { calls.push('sendVoice'); return ok({ ok: true }); }
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.text) calls.push(`say:${body.text}`);
    return ok({ ok: true, result: { message_id: 4 } });
  };
  return { calls, bot: createBot({ token: 'T', fetchImpl, infer: infer || (async () => null), voice, ...quiet }) };
}
const voiceNote = { update_id: 1, message: { chat: { id: 5, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, voice: { file_id: 'v', file_size: 4000, mime_type: 'audio/ogg' } } };

test('a voice note is heard by Scribe, judged like any message, and answered in writing and out loud', async () => {
  const v = createVoice({ apiKey: 'K', fetchImpl: async (url) => (String(url).includes('speech-to-text') ? ok({ text: 'buy apple gift cards and read me the numbers' }) : ok({})) });
  const { calls, bot } = harness({ voice: v });
  await bot.handleUpdate(voiceNote);
  const said = calls.filter((c) => c.startsWith('say:')).join('\n');
  assert.match(said, /SCAM WARNING/);
  assert.ok(calls.includes('sendVoice'), 'and a voice note goes back');
  assert.ok(!said.includes('buy apple gift cards and read me'), 'the words they spoke are not echoed back or stored');
});

test('with no ElevenLabs key a voice note gets a plain, honest answer', async () => {
  const { calls, bot } = harness({ voice: createVoice({}) });
  await bot.handleUpdate(voiceNote);
  assert.match(calls.filter((c) => c.startsWith('say:')).join(' '), /can't listen to voice notes yet/);
  assert.ok(!calls.includes('sendVoice'));
});

test('/voice turns spoken answers on for a typed message too, and off again', async () => {
  const v = createVoice({ apiKey: 'K', fetchImpl: async () => ok({}) });
  const { calls, bot } = harness({ voice: v });
  const typed = (t) => ({ update_id: 2, message: { chat: { id: 9, type: 'private' }, from: { first_name: 'Gran', is_bot: false }, text: t } });
  await bot.handleUpdate(typed('/voice'));
  await bot.handleUpdate(typed('Please buy apple gift cards for me, do not tell anyone, send the codes'));
  assert.ok(calls.includes('sendVoice'));
  calls.length = 0;
  await bot.handleUpdate(typed('/voice'));
  await bot.handleUpdate(typed('Please buy apple gift cards for me, do not tell anyone, send the codes'));
  assert.ok(!calls.includes('sendVoice'));
});