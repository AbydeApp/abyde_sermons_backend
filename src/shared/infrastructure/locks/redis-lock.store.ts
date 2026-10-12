import { Inject, Injectable } from '@nestjs/common';
import {
  type LockAcquireResult,
  type LockStore,
  LocksStorage,
} from '@nestjs/locks';
import { RedisConnection } from '../redis/redis.provider.js';

const PREFIX = 'abyde:lock:';
/** Store-wide counter: every successful acquisition gets a token greater than all before it. */
const FENCING_COUNTER = 'abyde:lock-fencing-token';

// Each script is atomic in Redis. Expiry is measured by Redis' own clock (PX / PEXPIRE), so every
// instance agrees on when a lock has expired regardless of its local clock.
const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])
end
return 0`;
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * Distributed locks in Redis for @nestjs/locks, shared by every API and worker replica.
 * (Never an in-process store in production: that would only exclude callers in one process.)
 */
@Injectable()
export class RedisLockStore implements LockStore {
  constructor(
    @Inject(RedisConnection) private readonly redis: RedisConnection,
    @Inject(LocksStorage) storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    const token = Number(
      await this.redis.client.eval(
        ACQUIRE,
        2,
        PREFIX + key,
        FENCING_COUNTER,
        owner,
        String(ttl),
      ),
    );
    return token > 0
      ? { acquired: true, fencingToken: token }
      : { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    return (
      Number(
        await this.redis.client.eval(
          RENEW,
          1,
          PREFIX + key,
          owner,
          String(ttl),
        ),
      ) === 1
    );
  }

  async release(key: string, owner: string): Promise<boolean> {
    return (
      Number(await this.redis.client.eval(RELEASE, 1, PREFIX + key, owner)) ===
      1
    );
  }
}
