// Live view of the server during Checkpoint 2 and the expo: who is online, how many pairs, open requests.
//   DEMO_KEY=... npm run watch -- https://vouch-co1l.onrender.com
// Add --reset to also do a soft reset once (keeps users and pairs), or --once to print one snapshot and exit.
// Needs DEMO_KEY set on the server. The key stays in your terminal; it is never printed.
const args = process.argv.slice(2);
const url = (args.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:3000').replace(/\/$/, '');
const key = process.env.DEMO_KEY;
if (!key) { console.error('Set DEMO_KEY first, for example:  DEMO_KEY=... npm run watch -- <url>'); process.exit(2); }

async function api(path, method = 'GET') {
  const res = await fetch(`${url}${path}`, { method, headers: { 'x-demo-key': key } });
  if (res.status === 403) throw new Error('wrong DEMO_KEY');
  if (res.status === 404) throw new Error('the server has no DEMO_KEY set, or this is the wrong address');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const show = (s) => {
  const time = new Date().toLocaleTimeString();
  const people = s.users.length
    ? s.users.map((u) => `${u.online ? '●' : '○'} ${u.name} (${u.friends} friend${u.friends === 1 ? '' : 's'})`).join('   ')
    : '(nobody registered)';
  return `${time}  pairs: ${s.pairs}  open requests: ${s.openRequests}  |  ${people}`;
};

try {
  if (args.includes('--reset')) {
    const r = await api('/demo/reset', 'POST');
    console.log(`soft reset done (${r.users} users kept)`);
  }
  let last = '';
  const tick = async () => {
    try {
      const line = show(await api('/demo/status'));
      if (line.slice(11) !== last) { console.log(line); last = line.slice(11); } // print only when something changed
    } catch (e) { if (args.includes('--once')) throw e; console.log(`${new Date().toLocaleTimeString()}  ${e.message}`); }
  };
  await tick();
  if (!args.includes('--once')) { console.log('watching (Ctrl+C to stop). ● online  ○ offline'); setInterval(tick, 2000); }
} catch (e) { console.error(e.message); process.exit(1); }
