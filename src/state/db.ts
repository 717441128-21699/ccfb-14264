/**
 * IndexedDB 持久化：样带元数据 + 照片 Blob。
 * 两个 object store：transects（键值文档）、blobs（二进制）。
 */
import type { Transect } from './model';

const DB_NAME = 'reef-rugosity';
const DB_VERSION = 1;
const STORE_T = 'transects';
const STORE_B = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_T)) {
        const s = db.createObjectStore(STORE_T, { keyPath: 'id' });
        s.createIndex('year', 'year', { unique: false });
        s.createIndex('site', 'site', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_B)) {
        db.createObjectStore(STORE_B);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function getAllTransects(): Promise<Transect[]> {
  return tx(STORE_T, 'readonly', (s) => s.getAll() as IDBRequest<Transect[]>);
}

export async function putTransect(t: Transect): Promise<void> {
  await tx(STORE_T, 'readwrite', (s) => s.put(t));
}

export async function deleteTransect(id: string): Promise<void> {
  await tx(STORE_T, 'readwrite', (s) => s.delete(id));
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await tx(STORE_B, 'readwrite', (s) => s.put(blob, key));
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return tx(STORE_B, 'readonly', (s) => s.get(key) as IDBRequest<Blob | undefined>);
}

export async function deleteBlob(key: string): Promise<void> {
  await tx(STORE_B, 'readwrite', (s) => s.delete(key));
}

export function uid(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
