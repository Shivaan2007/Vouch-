// Starts the Vouch server WITH the Watch service attached (message bots + live call listener + app alerts).
// Same as `npm start`, plus Watch. It does not change any server file: it uses what createVouchServer already exposes.
//   node --env-file=.env bot/serve.js
import fs from 'node:fs';
import { createVouchServer } from '../server/src/app.js';
import { attachWatch } from './watch.js';

// Keys in a .env file work whether or not the process was started with --env-file.
try { if (fs.existsSync('.env') && process.loadEnvFile) process.loadEnvFile('.env'); } catch { /* the real environment still applies */ }

const server = createVouchServer({ dbPath: process.env.DB_PATH || 'vouch.db' });
const watch = attachWatch({ httpServer: server.httpServer, io: server.io, db: server.db, log: (...a) => console.log(...a) });
const port = Number(process.env.PORT) || 3000;
server.listen(port).then(async (p) => {
  console.log(`Vouch (with Watch) listening on :${p}.`);
  await watch.ready; // wait for Telegram to answer, so this line tells the truth
  const ch = watch.channels().map((c) => c.name).join(', ') || 'none configured';
  console.log(`Message doors: ${ch}. Call listening: ${process.env.GEMINI_API_KEY || process.env.ELEVENLABS_API_KEY ? 'on' : 'off (no GEMINI_API_KEY)'}.`);
});
process.on('SIGTERM', () => { watch.stop(); process.exit(0); });
