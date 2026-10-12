import { Inject, Injectable } from '@nestjs/common';
import type { CachePort } from '../../application/ports/cache.port.js';
import { RedisConnection } from '../redis/redis.provider.js';

const PREFIX = 'abyde:';

@Injectable()
export class RedisCacheAdapter implements CachePort {
  constructor(
    @Inject(RedisConnection) private readonly redis: RedisConnection,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.client.get(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(
      PREFIX + key,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }

  async setIfAbsent<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.client.set(
      PREFIX + key,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async take<T>(key: string): Promise<T | null> {
    const raw = await this.redis.client.getdel(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0)
      await this.redis.client.del(...keys.map((key) => PREFIX + key));
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.redis.client
      .multi()
      .incr(PREFIX + key)
      .expire(PREFIX + key, ttlSeconds, 'NX')
      .exec();
    return Number(results?.[0]?.[1] ?? 0);
  }
}
