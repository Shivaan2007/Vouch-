import { createVouchServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const server = createVouchServer({ dbPath: process.env.DB_PATH || 'vouch.db' });
server.listen(port).then((p) => console.log(`Vouch listening on :${p}`));

// Last-resort safety net: log the message only (never a payload) and keep serving. A restart on the free plan erases every pairing.
process.on('uncaughtException', (e) => console.error(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => console.error(`unhandled rejection: ${e?.message ?? e}`));
