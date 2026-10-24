import crypto from 'node:crypto';
import { io as ioc } from 'socket.io-client';
import { createVouchServer } from '../src/app.js';

// A fake phone: real P-256 keys, signs like WebCrypto (raw r||s), talks over a real socket.
export class Phone {
  constructor(url, name) {
    this.name = name;
    this.userId = `user-${crypto.randomBytes(6).toString('hex')}`;
    this.sign = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.ecdh = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.socket = ioc(url, { transports: ['websocket'], forceNew: true });
    this.events = [];
    this.waiters = [];
    this.socket.onAny((ev, payload) => {
      this.events.push({ ev, payload });
      this.waiters = this.waiters.filter((w) => !w(ev, payload));
    });
  }
  get signPub() { return this.sign.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
  get ecdhPub() { return this.ecdh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
  get keys() { return { userId: this.userId, name: this.name, signPub: this.signPub, ecdhPub: this.ecdhPub }; }
  connected() { return this.socket.connected ? Promise.resolve() : new Promise((r) => this.socket.once('connect', r)); }
  call(ev, payload) {
    return new Promise((res) => this.socket.emit(ev, payload, res));
  }
  signMsg(msg) {
    return crypto.sign('sha256', Buffer.from(msg), { key: this.sign.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  }
  signAnswer(requestId, answer, over = {}) {
    const ts = over.ts ?? Date.now();
    const nonce = over.nonce ?? crypto.randomBytes(8).toString('hex');
    return { requestId, answer, ts, nonce, sig: this.signMsg(`${requestId}|${answer}|${ts}|${nonce}`) };
  }
  register() { return this.call('user:register', this.keys); }
  // Wait for the next (or an already received) event that matches.
  waitFor(ev, test = () => true, timeout = 3000) {
    const hit = this.events.find((e) => e.ev === ev && test(e.payload));
    if (hit) return Promise.resolve(hit.payload);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev} on ${this.name}`)), timeout);
      this.waiters.push((e, p) => {
        if (e === ev && test(p)) { clearTimeout(t); resolve(p); return true; }
        return false;
      });
    });
  }
  close() { this.socket.close(); }
}

export async function startServer(opts = {}) {
  const server = createVouchServer({ log: () => {}, ...opts });
  const port = await server.listen(0);
  const url = `http://localhost:${port}`;
  const phones = [];
  const phone = async (name) => {
    const p = new Phone(url, name);
    phones.push(p);
    await p.connected();
    return p;
  };
  return {
    server, url, phone,
    async stop() { phones.forEach((p) => p.close()); await server.close(); },
  };
}

// Register `a`, `b` and pair them.
export async function pair(a, b) {
  await a.register();
  const { token } = await a.call('pair:start', { userId: a.userId });
  return b.call('pair:complete', { token, ...b.keys });
}

// Send a verify:request from `from` to `to`.
export function request(from, to, over = {}) {
  const requestId = over.requestId ?? `req-${crypto.randomBytes(6).toString('hex')}`;
  return from.call('verify:request', {
    requestId, claimedUserId: to.userId, amount: 20, paymentMethod: 'venmo_cashapp_zelle',
    text: 'new number lost my wallet venmo me $20 rn', ts: Date.now(), ...over,
  }).then((res) => ({ requestId, res }));
}
