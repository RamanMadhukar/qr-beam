// Received transfers are kept in IndexedDB so they survive reloads and work offline.

const DB_NAME = 'qr-beam';
const STORE = 'transfers';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

// record: { id, receivedAt, bytes, items: [{ kind, name, type, size, blob }] }
export async function saveTransfer(record) {
  await run('readwrite', (store) => store.put(record));
  // Ask the browser not to evict our data under storage pressure. Best effort.
  navigator.storage?.persist?.().catch(() => {});
}

export async function listTransfers() {
  const all = (await run('readonly', (store) => store.getAll())) ?? [];
  return all.sort((a, b) => b.receivedAt - a.receivedAt);
}

export function deleteTransfer(id) {
  return run('readwrite', (store) => store.delete(id));
}
