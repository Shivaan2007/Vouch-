// IndexedDB storage for the device identity, keys and friends. Browser only, no libraries.
// CryptoKey objects are stored directly (structured clone) so private keys stay non-extractable.
// If the browser won't give us IndexedDB (some private modes / locked-down webviews) we fall back to
// memory for this page session so the app still works; isPersistent() tells the UI so it can warn.

const DB_NAME = 'vouch';
const DB_VERSION = 1;
let dbPromise = null;
let memory = false;
let lastError = '';
const mem = { kv: new Map(), friends: new Map() };

/** True when keys survive a reload (IndexedDB works); false in the in-memory fallback. */
export function isPersistent() { return !memory; }

/** Why persistence is off, for the UI and console. */
export function storageProblem() { return lastError; }

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('friends')) db.createObjectStore('friends', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(new Error(`Could not open database: ${req.error && (req.error.name + ' ' + req.error.message)}`));
    req.onblocked = () => reject(new Error('Database is blocked by another open tab; close other Vouch tabs'));
  });
  return dbPromise;
}

// Run one request against a store. Falls back to memory if IndexedDB can't be opened.
async function run(storeName, mode, method, ...args) {
  if (!memory) {
    let db;
    try { db = await openDb(); } catch (e) {
      memory = true; dbPromise = null;
      lastError = (e && e.message) || String(e);
      console.warn('Vouch: using in-memory storage:', lastError);
    }
    if (db) return idbRun(db, storeName, mode, method, args);
  }
  return memRun(storeName, method, args);
}

function idbRun(db, storeName, mode, method, args) {
  return new Promise((resolve, reject) => {
    let tx; let result;
    try {
      tx = db.transaction(storeName, mode);
      const req = tx.objectStore(storeName)[method](...args);
      req.onsuccess = () => { result = req.result; };
    } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(new Error(`Database error in ${storeName}: ${tx.error && tx.error.message}`));
    tx.onabort = () => reject(new Error(`Database transaction aborted in ${storeName}: ${tx.error && tx.error.message}`));
  });
}

function memRun(storeName, method, args) {
  const m = mem[storeName];
  if (method === 'get') return m.get(args[0]);
  if (method === 'getAll') return [...m.values()];
  if (method === 'delete') { m.delete(args[0]); return undefined; }
  if (method === 'clear') { m.clear(); return undefined; }
  // put(value, key?) - the friends store uses value.id as the key
  const [value, key] = args;
  m.set(storeName === 'friends' ? value.id : key, value);
  return undefined;
}

/** @returns {Promise<{id: string, name: string}|null>} */
export async function getIdentity() {
  return (await run('kv', 'readonly', 'get', 'identity')) || null;
}

/** @param {{id: string, name: string}} identity */
export function saveIdentity({ id, name }) {
  return run('kv', 'readwrite', 'put', { id, name }, 'identity');
}

/** @returns {Promise<{signKeyPair: CryptoKeyPair, exchKeyPair: CryptoKeyPair}|null>} */
export async function getKeys() {
  return (await run('kv', 'readonly', 'get', 'keys')) || null;
}

/** @param {{signKeyPair: CryptoKeyPair, exchKeyPair: CryptoKeyPair}} keys */
export function saveKeys({ signKeyPair, exchKeyPair }) {
  return run('kv', 'readwrite', 'put', { signKeyPair, exchKeyPair }, 'keys');
}

/** @returns {Promise<object[]>} */
export async function listFriends() {
  return (await run('friends', 'readonly', 'getAll')) || [];
}

/** @param {string} id */
export async function getFriend(id) {
  return (await run('friends', 'readonly', 'get', id)) || null;
}

/** @param {{id: string, name: string, signPub: string, exchPub: string, wordKey: CryptoKey, pairedAt: number}} friend */
export function saveFriend(friend) {
  if (!friend || !friend.id) return Promise.reject(new Error('saveFriend needs an id'));
  return run('friends', 'readwrite', 'put', friend);
}

/** @param {string} id */
export function deleteFriend(id) {
  return run('friends', 'readwrite', 'delete', id);
}

// People this phone removed on purpose (a tampered link, or just "Remove"). The server may still list the link, and syncing
// would otherwise bring them straight back, so their public keys are remembered here and skipped when syncing.
// A deliberate new pairing with the same person clears the entry.
export async function getRemoved() {
  const list = await run('kv', 'readonly', 'get', 'removed');
  return Array.isArray(list) ? list : [];
}
export async function addRemoved(signPub) {
  if (!signPub) return;
  const list = await getRemoved();
  if (!list.includes(signPub)) await run('kv', 'readwrite', 'put', [...list, signPub].slice(-200), 'removed');
}
export async function clearRemoved(signPub) {
  const list = await getRemoved();
  if (list.includes(signPub)) await run('kv', 'readwrite', 'put', list.filter((s) => s !== signPub), 'removed');
}

// The last call's recording, only if the person switched recording on. It lives in this phone's own storage (never sent anywhere), only the
// most recent call is kept, and it is gone when the person deletes it or erases everything.
export function saveLastCall(rec) { return run('kv', 'readwrite', 'put', rec, 'lastcall'); }
export async function getLastCall() { return (await run('kv', 'readonly', 'get', 'lastcall')) || null; }
export function deleteLastCall() { return run('kv', 'readwrite', 'delete', 'lastcall'); }

/** Wipe identity, keys and friends. */
export async function resetAll() {
  await run('kv', 'readwrite', 'clear');
  await run('friends', 'readwrite', 'clear');
}
