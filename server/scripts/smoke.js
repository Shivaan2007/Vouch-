// Runs one full request against a running server with two fake phones:
// register, pair, $20 request, signed Yes -> green; then a "Not me" -> red + circle alert.
//   npm run smoke -- https://vouch.onrender.com
//   npm run smoke -- http://localhost:3000
// It leaves two fake users on the server. Run it BEFORE pairing the real demo phones, then do a
// Wipe on /demo (or: DEMO_KEY=... npm run smoke -- <url> --cleanup, which wipes everything).
import { Phone, pair, request } from '../test/helpers.js';

const url = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const cleanup = process.argv.includes('--cleanup');
const steps = [];
const ok = (name) => { steps.push(name); console.log(`  ok  ${name}`); };

async function run() {
  const health = await fetch(`${url}/health`).then((r) => r.json());
  if (!health.ok) throw new Error('health check failed');
  ok('health');

  const [req, friend, third] = [new Phone(url, 'SmokeA'), new Phone(url, 'SmokeB'), new Phone(url, 'SmokeC')];
  try {
    await Promise.all([req, friend, third].map((p) => p.connected()));
    ok('three sockets connected');
    const paired = await pair(friend, req);
    if (!paired.ok) throw new Error(`pair failed: ${paired.error}`);
    await pair(friend, third);
    ok('pairing + keys exchanged');

    const a = await request(req, friend);
    if (!a.res.ok) throw new Error(`request failed: ${a.res.error}`);
    await friend.waitFor('verify:prompt');
    ok('prompt delivered');
    const yes = await friend.call('verify:answer', friend.signAnswer(a.requestId, 'yes'));
    if (!yes.ok) throw new Error(`signed answer rejected: ${yes.error}`);
    const green = await req.waitFor('verify:verdict', (v) => v.requestId === a.requestId && v.verdict === 'green');
    if (!green.stages.confidence.answerSig) throw new Error('verdict has no answerSig');
    ok('signed Yes -> green');

    const b = await request(req, friend);
    await friend.call('verify:answer', friend.signAnswer(b.requestId, 'not_me'));
    await req.waitFor('verify:verdict', (v) => v.requestId === b.requestId && v.verdict === 'red');
    await third.waitFor('circle:alert');
    ok('Not me -> red + alert on third phone');
  } finally {
    [req, friend, third].forEach((p) => p.close());
  }

  if (cleanup) {
    if (!process.env.DEMO_KEY) throw new Error('--cleanup needs DEMO_KEY');
    const r = await fetch(`${url}/demo/reset?hard=1`, { method: 'POST', headers: { 'x-demo-key': process.env.DEMO_KEY } });
    if (!r.ok) throw new Error(`cleanup failed: ${r.status}`);
    ok('cleanup (hard reset, ALL users and pairs deleted)');
  }
}

console.log(`smoke test against ${url}`);
run().then(() => { console.log(`PASS (${steps.length} checks)`); process.exit(0); },
  (e) => { console.error(`FAIL after: ${steps.at(-1) || 'start'}\n  ${e.message}`); process.exit(1); });
