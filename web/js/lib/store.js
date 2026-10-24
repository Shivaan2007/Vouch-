// IndexedDB storage for the device identity, keys and friends. Browser only, no libraries.
// CryptoKey objects are stored directly (structured clone) so private keys stay non-extractable.

const DB_NAME = 'vouch';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    req.onerror = () => { dbPromise = null; reject(new Error(`Could not open database: ${req.error && req.error.message}`)); };
    req.onblocked = () => { dbPromise = null; reject(new Error('Database is blocked by another open tab; close other Vouch tabs')); };
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(new Error(`Database error in ${storeName}: ${tx.error && tx.error.message}`));
    tx.onabort = () => reject(new Error(`Database transaction aborted in ${storeName}: ${tx.error && tx.error.message}`));
  });
}

/** @returns {Promise<{id: string, name: string}|null>} */
export async function getIdentity() {
  return (await run('kv', 'readonly', (s) => s.get('identity'))) || null;
}

/** @param {{id: string, name: string}} identity */
export function saveIdentity({ id, name }) {
  return run('kv', 'readwrite', (s) => s.put({ id, name }, 'identity'));
}

/** @returns {Promise<{signKeyPair: CryptoKeyPair, exchKeyPair: CryptoKeyPair}|null>} */
export async function getKeys() {
  return (await run('kv', 'readonly', (s) => s.get('keys'))) || null;
}

/** @param {{signKeyPair: CryptoKeyPair, exchKeyPair: CryptoKeyPair}} keys */
export function saveKeys({ signKeyPair, exchKeyPair }) {
  return run('kv', 'readwrite', (s) => s.put({ signKeyPair, exchKeyPair }, 'keys'));
}

/** @returns {Promise<object[]>} */
export async function listFriends() {
  return (await run('friends', 'readonly', (s) => s.getAll())) || [];
}

/** @param {string} id */
export async function getFriend(id) {
  return (await run('friends', 'readonly', (s) => s.get(id))) || null;
}

/** @param {{id: string, name: string, signPub: string, exchPub: string, wordKey: CryptoKey, pairedAt: number}} friend */
export function saveFriend(friend) {
  if (!friend || !friend.id) return Promise.reject(new Error('saveFriend needs an id'));
  return run('friends', 'readwrite', (s) => s.put(friend));
}

/** @param {string} id */
export function deleteFriend(id) {
  return run('friends', 'readwrite', (s) => s.delete(id));
}

/** Wipe identity, keys and friends. */
export async function resetAll() {
  await run('kv', 'readwrite', (s) => s.clear());
  await run('friends', 'readwrite', (s) => s.clear());
}
