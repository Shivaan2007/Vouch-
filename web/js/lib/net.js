// Socket client helper (PROTOCOL v2). Owned by A. Needs <script src="/socket.io/socket.io.js"></script> on the page,
// which defines the global `io`.
//
//   import { connect, call, on, setIdentity } from './lib/net.js';
//   setIdentity({
//     userId,                                        // saved after the first register, or null on a new device
//     sign: async (message) => base64RawSignature,   // signs with the non-extractable signing key
//     register: async (nonce) => ({ name, signPub, exchPub, sig }),  // sig = sign(authString(nonce)); returns the user:register body
//     onUserId: (id) => save(id),                    // called when the server issues a userId
//   });
//   await connect();
//   const { token } = await call('pair:offer', {});

import { authString } from './canonical.js';

let socket = null;
let identity = null;
let nonce = null;
const listeners = new Map(); // event -> Set<fn>, kept across reconnects

export function setIdentity(id) { identity = id; }

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  socket?.on(event, fn);
  return () => { listeners.get(event)?.delete(fn); socket?.off(event, fn); };
}

// Resolves with the server's ack payload (without `ok`); rejects with Error(CODE) on { ok:false }.
export function call(event, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('NOT_CONNECTED'));
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (res && res.ok) { const { ok, ...rest } = res; resolve(rest); } else reject(new Error(res?.error || 'SERVER_ERROR'));
    });
  });
}

// Runs on every (re)connect once the server's auth:challenge arrives: login, or register if the server does not know us
// (first run, or its database was wiped).
async function authenticate() {
  if (!identity) return;
  try {
    if (!identity.userId) throw new Error('UNKNOWN_USER');
    await call('auth:login', { userId: identity.userId, sig: await identity.sign(authString(nonce)) });
  } catch (e) {
    if (e.message !== 'UNKNOWN_USER' || !identity.register) throw e;
    const { userId } = await call('user:register', await identity.register(nonce));
    identity.userId = userId;
    identity.onUserId?.(userId);
  }
}

export function connect(url = undefined) {
  if (socket) return Promise.resolve(socket);
  socket = globalThis.io(url, { transports: ['websocket', 'polling'] });
  for (const [event, fns] of listeners) fns.forEach((fn) => socket.on(event, fn));
  let first = true;
  return new Promise((resolve) => {
    socket.on('auth:challenge', async (msg) => {
      nonce = msg.nonce;
      try { await authenticate(); } catch (e) { console.warn('auth failed', e.message); }
      if (first) { first = false; resolve(socket); }
    });
  });
}

export const isConnected = () => !!socket?.connected;
