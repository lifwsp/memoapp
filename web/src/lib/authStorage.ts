// ログイン情報の保存先。localStorage に加えて IndexedDB にも書く。
// iPhone の WebKit は localStorage を遅れてディスクに書くため、ログイン直後にアプリを
// スワイプで終了すると保存が消えることがある。IndexedDB はトランザクション完了時点で
// 確定するので、こちらを控えとして使い、localStorage が空なら IndexedDB から戻す。

const DB = "wristmemo-auth";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 容量不足などは IndexedDB 側に任せる */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* noop */
    }
  },
};

export const authStorage = {
  async getItem(key: string): Promise<string | null> {
    const v = ls.get(key);
    if (v !== null) return v;
    try {
      const saved = await idb<string>("readonly", (s) => s.get(key));
      if (typeof saved === "string") {
        ls.set(key, saved);
        return saved;
      }
    } catch {
      /* IndexedDB が使えない環境 */
    }
    return null;
  },
  async setItem(key: string, value: string) {
    ls.set(key, value);
    try {
      await idb("readwrite", (s) => s.put(value, key));
    } catch {
      /* noop */
    }
  },
  async removeItem(key: string) {
    ls.del(key);
    try {
      await idb("readwrite", (s) => s.delete(key));
    } catch {
      /* noop */
    }
  },
};

/** ブラウザに「このサイトの保存データは消さないで」と頼む（対応していれば） */
export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
