import { Inject, Injectable } from '@nestjs/common';
import { RedisConnection } from '../redis/redis.provider.js';

const PREFIX = 'abyde:fence:';

// Records the token if it is the highest seen for the key; returns 0 when a higher one exists.
const ADVANCE = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`;

/** A newer holder has taken over: this run must stop writing. */
export class StaleLockHolderError extends Error {
  constructor(key: string, token: number) {
    super(`Fencing token ${token} for ${key} has been superseded`);
    this.name = 'StaleLockHolderError';
  }
}

/**
 * Fencing check shared by every replica. Each lock acquisition gets a larger token; a holder that
 * paused past its lease and wakes up after another instance took over sees a higher recorded token
 * and is rejected before it writes.
 */
@Injectable()
export class FencingRegistry {
  constructor(
    @Inject(RedisConnection) private readonly redis: RedisConnection,
  ) {}

  /** Records `token` as the current holder (rejects if a newer holder already registered). */
  async advance(key: string, token: number): Promise<void> {
    if (
      Number(
        await this.redis.client.eval(ADVANCE, 1, PREFIX + key, String(token)),
      ) !== 1
    ) {
      throw new StaleLockHolderError(key, token);
    }
  }

  async assertCurrent(key: string, token: number): Promise<void> {
    const current = Number((await this.redis.client.get(PREFIX + key)) ?? 0);
    if (current > token) throw new StaleLockHolderError(key, token);
  }
}
