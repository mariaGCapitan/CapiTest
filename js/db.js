// Almacenamiento en el dispositivo (IndexedDB). outbox guarda los cambios que faltan por subir al servidor.

const NAME = 'capitest';
const VERSION = 2;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['groups', 'exams']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const db = {
  all: store => tx(store, 'readonly', s => s.getAll()),
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  getMeta: key => tx('meta', 'readonly', s => s.get(key)),
  setMeta: (key, val) => tx('meta', 'readwrite', s => s.put(val, key)),
  clearAll: async () => {
    for (const s of ['groups', 'exams', 'meta', 'outbox']) await tx(s, 'readwrite', st => st.clear());
  },
};

// Pide al navegador que no borre los datos cuando le falte espacio.
export async function askPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* no disponible */ }
  return false;
}
