// Concurrency check: many circles of fake phones run requests at the same time against one server.
//   npm run stress                       (starts its own in-memory server)
//   npm run stress -- https://host       (runs against a deployed server; leaves fake users behind)
// Checks that every verdict is the right colour for its scenario, nothing gets crossed between circles,
// and that nobody has a verdict they should not have.
import { Phone, pair, request, startServer } from '../test/helpers.js';

const CIRCLES = 12;
const target = process.argv[2];
const t0 = Date.now();
const lat = [];

const SCENARIOS = [
  { name: 'tier1 yes', amount: 2000, answer: 'yes', want: 'green' },
  { name: 'not me', amount: 2000, answer: 'not_me', want: 'red' },
  { name: 'gift card yes', amount: 2000, method: 'gift_card', answer: 'yes', want: 'amber' },
  { name: 'tier2 yes + word', amount: 6000, answer: 'yes', word: true, want: 'green' },
  { name: 'tier2 yes, no word', amount: 6000, answer: 'yes', want: 'amber' },
];

async function circle(url, i) {
  const [checker, friend, third] = ['R', 'F', 'T'].map((n) => new Phone(url, `${n}${i}`));
  const all = [checker, friend, third];
  try {
    await Promise.all(all.map((p) => p.ready()));
    for (const p of all) if (!(await p.register()).ok) throw new Error('register failed');
    if (!(await pair(friend, checker)).ok || !(await pair(friend, third)).ok) throw new Error('pairing failed');
    for (const s of SCENARIOS) {
      const started = Date.now();
      const rq = await request(checker, friend, { amountCents: s.amount, method: s.method || 'venmo_cashapp_zelle' });
      if (!rq.res.ok) throw new Error(`${s.name}: request failed ${rq.res.error}`);
      await friend.waitFor('verify:prompt', (p) => p.requestId === rq.requestId);
      const ans = await friend.call('verify:answer', friend.signAnswer(rq, s.answer));
      if (!ans.ok) throw new Error(`${s.name}: answer failed ${ans.error}`);
      if (s.word) await checker.call('verify:wordcheck', { requestId: rq.requestId, passed: true });
      const wantStage = (v) => v.requestId === rq.requestId && v.stages.confidence.answer === s.answer && (!s.word || v.stages.confidence.wordOk);
      const v = await checker.waitFor('verify:update', wantStage, 8000);
      if (v.verdict !== s.want) throw new Error(`${s.name}: got ${v.verdict}, wanted ${s.want}`);
      if (s.answer === 'not_me') {
        const a = await third.waitFor('circle:alert', (x) => x.requestId === rq.requestId, 8000);
        if (a.impersonatedName !== `F${i}`) throw new Error('alert named the wrong person');
      }
      lat.push(Date.now() - started);
    }
    // Nobody should ever see another circle's traffic.
    if (third.events.some((e) => e.ev === 'verify:update')) throw new Error('third member received an update it should not see');
    // Every update the checker saw belongs to this checker.
    if (checker.events.some((e) => e.ev === 'verify:update' && e.payload.checkerId !== checker.userId)) throw new Error('received another circle\'s update');
  } finally {
    all.forEach((p) => p.close());
  }
}

const own = target ? null : await startServer();
const url = target ? target.replace(/\/$/, '') : own.url;
console.log(`stress: ${CIRCLES} circles x ${SCENARIOS.length} scenarios against ${url}`);
const results = await Promise.allSettled(Array.from({ length: CIRCLES }, (_, i) => circle(url, i)));
const failed = results.filter((r) => r.status === 'rejected');
failed.slice(0, 5).forEach((r) => console.error('  FAIL', r.reason.message));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
console.log(`${lat.length} requests ok, ${failed.length}/${CIRCLES} circles failed, median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, total ${Date.now() - t0} ms`);
if (own) await own.stop();
process.exit(failed.length ? 1 : 0);
