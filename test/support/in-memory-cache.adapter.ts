import type { CachePort } from '../../src/shared/application/ports/cache.port.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Process-local cache for tests and single-process tooling. Bounded to avoid unbounded growth. */
export class InMemoryCacheAdapter implements CachePort {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (JSON.parse(entry.value) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) this.evictExpired();
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async setIfAbsent<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async take<T>(key: string): Promise<T | null> {
    const value = await this.get<T>(key);
    this.entries.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    const next = (entry ? Number(JSON.parse(entry.value)) : 0) + 1;
    this.entries.set(key, {
      value: JSON.stringify(next),
      expiresAt: entry?.expiresAt ?? this.now() + ttlSeconds * 1000,
    });
    return next;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
