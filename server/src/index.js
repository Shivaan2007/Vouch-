import { createVouchServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const server = createVouchServer({ dbPath: process.env.DB_PATH || 'vouch.db' });
server.listen(port).then((p) => console.log(`Vouch listening on :${p}`));
