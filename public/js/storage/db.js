/**
 * IndexedDB sarmalayıcısı (Promise tabanlı).
 *
 * Nesne depoları (şema sürüm 1):
 *   meta       {key, value}                       — kurulum bilgisi, ayarlar (hassas olmayan)
 *   users      {id, username, role, wrap, ...}    — kullanıcılar ve sarılmış veri anahtarları
 *   personnel  {id, enc, updatedAt}               — şifreli personel kayıtları (biyometrik şablon dahil)
 *   vehicles   {id, enc, updatedAt}               — şifreli araç kayıtları
 *   events     {id, ts, kind, enc}                — şifreli algılama olayları   (index: ts)
 *   audit      {id, ts, enc, hash, prev}          — şifreli işlem kayıtları, hash zinciri (index: ts)
 */

export const DB_NAME = 'guvenlik-asistani';
export const DB_VERSION = 1;

let dbPromise = null;

export function openDb(name = DB_NAME) {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('users')) {
        const s = db.createObjectStore('users', { keyPath: 'id' });
        s.createIndex('username', 'username', { unique: true });
      }
      if (!db.objectStoreNames.contains('personnel')) db.createObjectStore('personnel', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('vehicles')) db.createObjectStore('vehicles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('audit')) {
        const s = db.createObjectStore('audit', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Veritabanı başka bir sekmede açık. Diğer sekmeleri kapatın.'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('İşlem iptal edildi'));
    Promise.resolve(fn(t.objectStore(store), t)).then((r) => { result = r; }, reject);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
  getAll: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
  put: (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value))),
  delete: (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key))),
  clear: (store) => tx(store, 'readwrite', (s) => wrap(s.clear())),
  count: (store) => tx(store, 'readonly', (s) => wrap(s.count())),

  /** ts indeksine göre en yeni N kayıt */
  async latest(store, limit = 50) {
    return tx(store, 'readonly', (s) => new Promise((resolve, reject) => {
      const out = [];
      const req = s.index('ts').openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  },

  /** ts < cutoff olan kayıtları siler; silinen sayısını döner */
  async deleteOlderThan(store, cutoff) {
    return tx(store, 'readwrite', (s) => new Promise((resolve, reject) => {
      let n = 0;
      const req = s.index('ts').openCursor(IDBKeyRange.upperBound(cutoff, true));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(n);
        c.delete(); n++;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  },
};

export async function getMeta(key, fallback = null) {
  const r = await db.get('meta', key);
  return r ? r.value : fallback;
}

export async function setMeta(key, value) {
  return db.put('meta', { key, value });
}

/** Kalıcı depolama talebi (tarayıcının veriyi kendiliğinden silmesini önler) */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* desteklenmiyor */ }
  return false;
}

export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
