import crypto from 'node:crypto';
import { io as ioc } from 'socket.io-client';
import { createVouchServer } from '../src/app.js';
import { authString, answerString, confirmString, randomNonce } from '../../web/js/lib/canonical.js';

// A fake phone: real P-256 keys, signs like WebCrypto (raw r||s), talks over a real socket (PROTOCOL v2).
export class Phone {
  constructor(url, name) {
    this.name = name;
    this.userId = null;
    this.sign = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.exch = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.socket = ioc(url, { transports: ['websocket'], forceNew: true });
    this.events = [];
    this.waiters = [];
    this.nonce = null;
    this.socket.onAny((ev, payload) => {
      if (ev === 'auth:challenge') this.nonce = payload.nonce;
      this.events.push({ ev, payload });
      this.waiters = this.waiters.filter((w) => !w(ev, payload));
    });
  }
  get signPub() { return this.sign.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
  get exchPub() { return this.exch.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
  async ready() {
    if (!this.socket.connected) await new Promise((r) => this.socket.once('connect', r));
    await this.waitFor('auth:challenge');
  }
  call(ev, payload) { return new Promise((res) => this.socket.emit(ev, payload, res)); }
  signMsg(msg) {
    return crypto.sign('sha256', Buffer.from(msg), { key: this.sign.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  }
  async register(over = {}) {
    const res = await this.call('user:register', {
      name: this.name, signPub: this.signPub, exchPub: this.exchPub, sig: this.signMsg(authString(this.nonce)), ...over,
    });
    if (res.ok) this.userId = res.userId;
    return res;
  }
  login(over = {}) {
    return this.call('auth:login', { userId: this.userId, sig: this.signMsg(authString(this.nonce)), ...over });
  }
  // answer / confirm signatures, built with the shared canonical strings. `rq` is what request() returned.
  signAnswer(rq, answer, over = {}) {
    const f = { requestId: rq.requestId, checkerId: rq.checkerId, claimedId: rq.claimedId, amountCents: rq.amountCents,
      method: rq.method, answer, ts: Date.now(), nonce: randomNonce(), ...over };
    const out = { requestId: f.requestId, answer: f.answer, ts: f.ts, nonce: f.nonce, sig: this.signMsg(answerString(f)) };
    if (rq.tier >= 2) out.retypedCents = rq.amountCents;
    return { ...out, ...(over.extra || {}) };
  }
  signConfirm(rq, answer, over = {}) {
    const f = { requestId: rq.requestId, confirmerId: this.userId, claimedId: rq.claimedId, amountCents: rq.amountCents,
      answer, ts: Date.now(), nonce: randomNonce(), ...over };
    return { requestId: f.requestId, answer: f.answer, ts: f.ts, nonce: f.nonce, sig: this.signMsg(confirmString(f)) };
  }
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
  // A phone that is connected, has the login challenge, and (unless told otherwise) is registered.
  const phone = async (name, { register = true } = {}) => {
    const p = new Phone(url, name);
    phones.push(p);
    await p.ready();
    if (register) {
      const res = await p.register();
      if (!res.ok) throw new Error(`register failed: ${res.error}`);
    }
    return p;
  };
  return { server, url, phone, async stop() { phones.forEach((p) => p.close()); await server.close(); } };
}

// `a` offers, `b` accepts. Both end up paired.
export async function pair(a, b) {
  const { token } = await a.call('pair:offer', {});
  return b.call('pair:accept', { token });
}

// checker sends verify:request to claimed. Returns what later calls need to sign.
export async function request(checker, claimed, over = {}) {
  const body = { claimedId: claimed.userId, amountCents: 2000, method: 'venmo_cashapp_zelle', channel: 'text',
    text: 'new number lost my wallet venmo me $20 rn', ...over };
  const res = await checker.call('verify:request', body);
  const tier = body.amountCents < 2500 ? 1 : body.amountCents <= 20000 ? 2 : 3;
  return { res, requestId: res.requestId, checkerId: checker.userId, claimedId: claimed.userId,
    amountCents: body.amountCents, method: body.method, tier };
}
