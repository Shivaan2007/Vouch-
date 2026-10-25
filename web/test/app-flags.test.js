// Demo phones are set up with a link, not by hand: /?aloud=1&size=3 is saved as the Display setting and removed from the address.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createMockServer } from '../dev/mock-server.js';
import { installFakeDom } from '../dev/fakedom.js';

const server = createMockServer();
const clients = [];
let url = '';
const dom = installFakeDom({ makeSocket: () => { const s = ioClient(url, { transports: ['websocket'], reconnection: false }); clients.push(s); return s; } });
const { loc, wait, text } = dom;

before(async () => {
  url = `http://localhost:${await server.listen(0)}`;
  loc.origin = url;
  loc.search = '?aloud=1&size=3&theme=hc&reading=1&bogus=9';
  await import('../js/app.js');
  await wait(500);
});
after(async () => { clients.forEach((s) => s.close()); await server.close(); });

test('a setup link turns on spoken warnings and the chosen display, and is remembered on the phone', () => {
  const saved = JSON.parse(localStorage.getItem('vouch-display'));
  assert.equal(saved.aloud, true);
  assert.equal(saved.size, 3);
  assert.equal(saved.theme, 'hc');
  assert.equal(saved.reading, true);
  assert.ok(text().includes('Welcome to Vouch'), 'and the app still starts normally');
});

test('the flags are removed from the address; anything else in it is left alone', () => {
  assert.equal(loc.search, '?bogus=9');
});