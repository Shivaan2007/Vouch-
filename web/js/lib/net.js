// Socket client helper. Owned by A, imported by B.
// Needs <script src="/socket.io/socket.io.js"></script> on the page (served by the server, defines global `io`).
//
//   import { connect, call, on, setIdentity } from './lib/net.js';
//   setIdentity({
//     userId,
//     register: async () => ({ userId, name, signPub, ecdhPub }),   // used on first run, or if the server forgot us
//     sign: async (message) => base64RawSignature,                  // signs with the non-extractable signing key
//   });
//   await connect();
//   const { token } = await call('pair:start', { userId });

let socket = null;
let identity = null;
const listeners = new Map(); // event -> Set<fn>, kept across reconnects

export function setIdentity(id) { identity = id; }

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  socket?.on(event, fn);
  return () => { listeners.get(event)?.delete(fn); socket?.off(event, fn); };
}

// Resolves with the server's ack payload (without `ok`); rejects with Error(code) on { ok: false }.
export function call(event, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('not_connected'));
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (res && res.ok) { const { ok, ...rest } = res; resolve(rest); } else reject(new Error(res?.error || 'server_error'));
    });
  });
}

async function login() {
  if (!identity) return;
  try {
    const { challenge } = await call('auth:challenge', { userId: identity.userId });
    const sig = await identity.sign(`login|${identity.userId}|${challenge}`);
    await call('auth:login', { userId: identity.userId, challenge, sig });
  } catch (e) {
    // Server does not know us (first run, or its database was wiped): register from scratch.
    if (e.message === 'unknown_user' && identity.register) await call('user:register', await identity.register());
    else throw e;
  }
}

// Connects and logs in. Re-logs in automatically after every reconnect; the server then resends pending prompts.
export function connect(url = undefined) {
  if (socket) return Promise.resolve(socket);
  socket = globalThis.io(url, { transports: ['websocket', 'polling'] });
  for (const [event, fns] of listeners) fns.forEach((fn) => socket.on(event, fn));
  socket.on('connect', () => { login().catch((e) => console.warn('login failed', e.message)); });
  return new Promise((resolve) => {
    socket.once('connect', async () => { try { await login(); } catch { /* reported above */ } resolve(socket); });
  });
}

export const isConnected = () => !!socket?.connected;
