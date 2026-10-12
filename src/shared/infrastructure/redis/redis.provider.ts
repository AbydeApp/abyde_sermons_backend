import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';

/** Single shared Redis connection for cache/rate-limit/idempotency (BullMQ manages its own). */
@Injectable()
export class RedisConnection implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      lazyConnect: false,
    });
    this.client.on('error', () => undefined); // surfaced through readiness checks instead
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
