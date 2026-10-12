import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { RedisConnection } from '../redis/redis.provider.js';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/** Fixed-window rate-limit counters in Redis, shared by every API instance behind the load balancer. */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    @Inject(RedisConnection) private readonly redis: RedisConnection,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `abyde:throttle:${throttlerName}:${key}`;
    const results = await this.redis.client
      .multi()
      .incr(redisKey)
      .pexpire(redisKey, ttl, 'NX')
      .pttl(redisKey)
      .exec();
    const totalHits = Number(results?.[0]?.[1] ?? 1);
    const timeToExpire = Math.max(
      0,
      Math.ceil(Number(results?.[2]?.[1] ?? ttl) / 1000),
    );
    const isBlocked = totalHits > limit;
    return {
      totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }
}
