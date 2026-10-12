export const CACHE = Symbol('CACHE');

export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Atomically sets the key only if absent. Returns true when this caller set it. */
  setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean>;
  /** Reads and deletes in one step (single-use tokens such as OAuth state). */
  take<T>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<void>;
  /** Fixed-window counter; returns the count after incrementing. */
  increment(key: string, ttlSeconds: number): Promise<number>;
}
