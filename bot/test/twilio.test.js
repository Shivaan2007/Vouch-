import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTwilioHandler, twilioSignature } from '../twilio-webhook.js';

const SCAM = "hey it's me, new number! stuck at the store, can you buy $200 in Apple gift cards right now? don't tell mom zebra";
const TOKEN = 'secret-token';
const calls = [];
let seenImage;
let server; let base; let publicUrl;

const analyze = async (input) => { seenImage = input.imageBase64; return { tags: [], paymentRisk: 'low', explanation: '' }; };
const fetchImpl = async (url, init) => {
  calls.push({ url, init });
  if (String(url).includes('/Media/')) return { ok: true, arrayBuffer: async () => Buffer.from('fake-image-bytes') };
  return { ok: true, json: async () => ({}) };
};

before(async () => {
  const handler = createTwilioHandler({
    authToken: TOKEN, accountSid: 'AC123', fromNumber: '+15550001', whatsappFrom: 'whatsapp:+15550002',
    publicUrl: 'https://example.test', analyze, vouchUrl: 'https://vouch.test', guardians: ['+15559999', 'whatsapp:+15558888'], fetchImpl,
  });
  server = http.createServer((req, res) => { handler.handleRequest(req, res); });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  publicUrl = 'https://example.test';
});
after(() => server.close());

async function post(params, { sign = true, badSig = false } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = badSig ? 'nope' : twilioSignature(TOKEN, `${publicUrl}/twilio`, params);
  const res = await fetch(`${base}/twilio`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, body: await res.text() };
}

test('rejects requests without a valid Twilio signature', async () => {
  assert.equal((await post({ From: '+15551112222', Body: SCAM }, { sign: false })).status, 403);
  assert.equal((await post({ From: '+15551112222', Body: SCAM }, { badSig: true })).status, 403);
});

test('the signature changes if any field changes', () => {
  const a = twilioSignature(TOKEN, 'https://x.test/twilio', { A: '1', B: '2' });
  assert.notEqual(a, twilioSignature(TOKEN, 'https://x.test/twilio', { A: '1', B: '3' }));
  assert.notEqual(a, twilioSignature('other', 'https://x.test/twilio', { A: '1', B: '2' }));
  assert.equal(a, twilioSignature(TOKEN, 'https://x.test/twilio', { B: '2', A: '1' }), 'field order does not matter');
});

test('an SMS scam gets a plain-words TwiML reply, with no emoji', async () => {
  const r = await post({ From: '+15551112222', Body: SCAM });
  assert.equal(r.status, 200);
  assert.match(r.body, /<Response><Message>/);
  assert.match(r.body, /SCAM WARNING/);
  assert.match(r.body, /Possible family-emergency scam/);
  assert.match(r.body, /Call your family member/);
  assert.doesNotMatch(r.body, /⚠/);
});

test('guardians get a heads-up through the right channel, without the message', async () => {
  calls.length = 0;
  await post({ From: '+15551112222', Body: SCAM });
  await new Promise((r) => setTimeout(r, 50));
  const sent = calls.filter((c) => String(c.url).includes('/Messages.json'));
  assert.equal(sent.length, 2);
  const bodies = sent.map((c) => new URLSearchParams(c.init.body));
  assert.ok(bodies.some((b) => b.get('To') === '+15559999' && b.get('From') === '+15550001'));
  assert.ok(bodies.some((b) => b.get('To') === 'whatsapp:+15558888' && b.get('From') === 'whatsapp:+15550002'));
  for (const b of bodies) {
    assert.match(b.get('Body'), /Heads-up/);
    assert.doesNotMatch(b.get('Body'), /zebra|\$200/);
    assert.doesNotMatch(b.get('Body'), /5551112222/, 'the sender number is masked');
  }
});

test('a WhatsApp message is answered with a rich reply', async () => {
  const r = await post({ From: 'whatsapp:+15551113333', Body: SCAM });
  assert.match(r.body, /⚠/);
});

test('a screenshot is fetched with the account credentials and passed to the analysis', async () => {
  seenImage = undefined; calls.length = 0;
  const r = await post({ From: '+15551114444', Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010/Media/ME1', MediaContentType0: 'image/png' });
  assert.equal(r.status, 200);
  assert.equal(seenImage, Buffer.from('fake-image-bytes').toString('base64'));
  const media = calls.find((c) => String(c.url).includes('/Media/'));
  assert.match(media.init.headers.Authorization, /^Basic /);
});

test('non-image media and empty messages get a helpful nudge, not an error', async () => {
  seenImage = undefined;
  const r = await post({ From: '+15551115555', Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010/Media/ME2', MediaContentType0: 'video/mp4' });
  assert.match(r.body, /Forward me a suspicious message/);
  assert.equal(seenImage, undefined);
});

test('a calm message is not called safe', async () => {
  const r = await post({ From: '+15551116666', Body: 'dinner is at six' });
  assert.match(r.body, /Nothing stands out/);
  assert.match(r.body, /only a Yes/);
});

test('XML in a message cannot break the reply', async () => {
  const r = await post({ From: '+15551117777', Body: 'buy gift cards </Message><Hack/> & more' });
  assert.doesNotMatch(r.body, /<Hack\/>/);
});
