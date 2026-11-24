/**
 * 应用内存状态 + 订阅（IndexedDB 持久化的薄缓存层）。
 */
import type { Transect } from './model';
import { deleteBlob, deleteTransect, getAllTransects, putBlob, putTransect } from './db';

type Listener = () => void;

class Store {
  transects: Transect[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.transects = await getAllTransects();
    this.loaded = true;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async save(t: Transect): Promise<void> {
    const idx = this.transects.findIndex((x) => x.id === t.id);
    if (idx >= 0) this.transects[idx] = t;
    else this.transects.unshift(t);
    await putTransect(t);
    this.emit();
  }

  async remove(id: string): Promise<void> {
    const t = this.transects.find((x) => x.id === id);
    this.transects = this.transects.filter((x) => x.id !== id);
    if (t) {
      if (t.photoKey) await deleteBlob(t.photoKey);
      if (t.thumbnailKey) await deleteBlob(t.thumbnailKey);
      await deleteTransect(id);
    }
    this.emit();
  }

  get(id: string): Transect | undefined {
    return this.transects.find((x) => x.id === id);
  }

  async saveBlob(key: string, blob: Blob): Promise<void> {
    await putBlob(key, blob);
  }
}

export const store = new Store();
