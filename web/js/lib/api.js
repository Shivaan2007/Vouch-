// Socket.io client for PROTOCOL v2. Needs <script src="/socket.io/socket.io.js"></script> (defines global `io`).
// The server emits auth:challenge { nonce } on every (re)connect; the app answers it with login or register.

let socket = null;
const listeners = new Map(); // event -> Set<fn>, kept across reconnects

/**
 * Subscribe to a server-pushed event. Returns an unsubscribe function.
 * @param {string} event
 * @param {(payload: any) => void} fn
 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  socket?.on(event, fn);
  return () => { listeners.get(event)?.delete(fn); socket?.off(event, fn); };
}

/**
 * Emit an event and resolve with the ack payload (without `ok`); rejects with Error(CODE) on { ok:false }.
 * @param {string} event
 * @param {object} [payload]
 * @param {number} [timeoutMs]
 */
export function call(event, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(new Error('OFFLINE'));
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (res && res.ok) { const { ok, ...rest } = res; resolve(rest); } else reject(new Error((res && res.error) || 'SERVER_ERROR'));
    });
  });
}

/**
 * Open the socket. onChallenge(nonce) runs on every connect; onStatus(bool) on connect/disconnect.
 * @param {{onChallenge: (nonce: string) => void, onStatus: (online: boolean) => void}} handlers
 */
export function connect({ onChallenge, onStatus }) {
  if (socket) return;
  socket = globalThis.io({ transports: ['websocket', 'polling'] });
  for (const [event, fns] of listeners) fns.forEach((fn) => socket.on(event, fn));
  socket.on('auth:challenge', (msg) => onChallenge(msg && msg.nonce));
  socket.on('connect', () => onStatus(true));
  socket.on('disconnect', () => onStatus(false));
}
