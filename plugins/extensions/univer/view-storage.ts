import { DesktopLocalStorageService } from '@univerjs/preset-sheets-core';
import type { ILocalStorageService } from '@univerjs/presets';

// Univer eagerly prepares its browser driver during module evaluation. Observe
// its readiness through the public service so opaque-frame denial is handled.
// All actual preference reads/writes below use per-view memory instead.
if (globalThis.origin === 'null')
  void new DesktopLocalStorageService().getItem('univer-view-preferences').catch(() => undefined);

export class ViewStorage implements ILocalStorageService {
  private readonly values = new Map<string, unknown>();
  async getItem<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }
  async setItem<T>(key: string, value: T): Promise<T> {
    this.values.set(key, value);
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
  async clear(): Promise<void> {
    this.values.clear();
  }
  async key(index: number): Promise<string | null> {
    return [...this.values.keys()][index] ?? null;
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
  async iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
    let index = 0;
    for (const [key, value] of this.values) {
      const result = iteratee(value as T, key, ++index);
      if (result !== undefined) return result;
    }
    return undefined as U;
  }
}
