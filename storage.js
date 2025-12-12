const DB_NAME = 'epub-trans-db-v2'; // قمت بتغيير الاسم لضمان نسخة نظيفة
const STORE_STATE = 'state';
const STORE_CHUNKS = 'chunks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    // Use a try-catch for the callback logic
    try {
        const req = fn(store);
        // If the callback returns a request object, wait for it
        if (req && req instanceof IDBRequest) {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } else {
             // For complex logic that doesn't return a single request
             tx.oncomplete = () => resolve();
             tx.onerror = () => reject(tx.error);
        }
    } catch (e) {
        reject(e);
    }
  });
}

// حفظ الحالة العامة (رقم الفصل الحالي)
export async function saveState(obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, 'readwrite');
    tx.objectStore(STORE_STATE).put(obj, 'meta');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadState() {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_STATE, 'readonly');
    const req = tx.objectStore(STORE_STATE).get('meta');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// حفظ/استرجاع النصوص المترجمة (Chunks)
export async function saveChunk(key, text) {
  const db = await openDB();
  db.transaction(STORE_CHUNKS, 'readwrite').objectStore(STORE_CHUNKS).put(text, key);
}

export async function loadChunk(key) {
  const db = await openDB();
  return new Promise(resolve => {
    const req = db.transaction(STORE_CHUNKS, 'readonly').objectStore(STORE_CHUNKS).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function clearDB() {
  const db = await openDB();
  const tx = db.transaction([STORE_STATE, STORE_CHUNKS], 'readwrite');
  tx.objectStore(STORE_STATE).clear();
  tx.objectStore(STORE_CHUNKS).clear();
  return new Promise(resolve => { tx.oncomplete = () => resolve(); });
}
