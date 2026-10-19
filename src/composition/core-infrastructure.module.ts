import { Global, Logger, Module } from '@nestjs/common';
import { LocksModule } from '@nestjs/locks';
import { FencingRegistry } from '../shared/infrastructure/locks/fencing-registry.js';
import { RedisLockStore } from '../shared/infrastructure/locks/redis-lock.store.js';
import { createHash } from 'node:crypto';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../shared/application/jobs.js';
import { CACHE } from '../shared/application/ports/cache.port.js';
import { CLOCK } from '../shared/application/ports/clock.port.js';
import { QUEUE } from '../shared/application/ports/queue.port.js';
import {
  SECRET_BOX,
  TOKEN_GENERATOR,
} from '../shared/application/ports/secret-box.port.js';
import { UNIT_OF_WORK } from '../shared/application/ports/unit-of-work.port.js';
import { RedisCacheAdapter } from '../shared/infrastructure/cache/redis-cache.adapter.js';
import { SystemClock } from '../shared/infrastructure/clock/system-clock.js';
import { APP_CONFIG } from '../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../shared/infrastructure/config/env.schema.js';
import { AesGcmSecretBox } from '../shared/infrastructure/crypto/aes-gcm-secret-box.js';
import { RandomTokenGenerator } from '../shared/infrastructure/crypto/random-token-generator.js';
import { RedisThrottlerStorage } from '../shared/infrastructure/http/redis-throttler.storage.js';
import { MetricsService } from '../shared/infrastructure/observability/metrics.service.js';
import { ConnectionBudgetCheck } from '../shared/infrastructure/prisma/connection-budget.check.js';
import { PrismaService } from '../shared/infrastructure/prisma/prisma.service.js';
import { PrismaUnitOfWork } from '../shared/infrastructure/prisma/prisma-unit-of-work.js';
import { BullMqQueueAdapter } from '../shared/infrastructure/queue/bullmq-queue.adapter.js';
import { JOB_OBSERVER } from '../shared/infrastructure/queue/job-observer.js';
import { RedisConnection } from '../shared/infrastructure/redis/redis.provider.js';
import {
  READINESS_CHECKS,
  type ReadinessCheck,
} from '../modules/health/helper.js';
import {
  BullMqQueueInspector,
  QUEUE_INSPECTOR,
} from '../modules/system/queue-inspector.js';
import { THROTTLER_STORAGE } from './tokens.js';

const DEV_KEY_SEED = 'abyde-sermon-development-only-key';

/** Production infrastructure shared by every module: Postgres, Redis, BullMQ, crypto, clock, metrics. */
@Global()
@Module({
  // Shared locks for scheduled work live in Redis (RedisLockStore registers itself as the store).
  imports: [LocksModule.forRoot({ isGlobal: true, ttl: '60s' })],
  providers: [
    RedisLockStore,
    FencingRegistry,
    ConnectionBudgetCheck,
    PrismaService,
    RedisConnection,
    MetricsService,
    BullMqQueueAdapter,
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    { provide: CACHE, useClass: RedisCacheAdapter },
    { provide: QUEUE, useExisting: BullMqQueueAdapter },
    { provide: JOB_HANDLER_REGISTRY, useValue: new JobHandlerRegistry() },
    { provide: JOB_OBSERVER, useExisting: MetricsService },
    { provide: QUEUE_INSPECTOR, useClass: BullMqQueueInspector },
    { provide: CLOCK, useClass: SystemClock },
    { provide: TOKEN_GENERATOR, useClass: RandomTokenGenerator },
    { provide: THROTTLER_STORAGE, useClass: RedisThrottlerStorage },
    {
      provide: SECRET_BOX,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.PUBLISHING_ENCRYPTION_KEY)
          return new AesGcmSecretBox(config.PUBLISHING_ENCRYPTION_KEY);
        // Production requires a real key (enforced by env validation); this fallback is for local development only.
        new Logger('SecretBox').warn(
          'PUBLISHING_ENCRYPTION_KEY not set; using a development-only key',
        );
        return new AesGcmSecretBox(
          createHash('sha256').update(DEV_KEY_SEED).digest('base64'),
        );
      },
    },
    {
      provide: READINESS_CHECKS,
      inject: [PrismaService, RedisConnection],
      useFactory: (
        prisma: PrismaService,
        redis: RedisConnection,
      ): ReadinessCheck[] => [
        {
          name: 'database',
          check: async () => void (await prisma.client.$queryRaw`SELECT 1`),
        },
        { name: 'redis', check: async () => void (await redis.client.ping()) },
      ],
    },
  ],
  exports: [
    FencingRegistry,
    PrismaService,
    RedisConnection,
    MetricsService,
    BullMqQueueAdapter,
    UNIT_OF_WORK,
    CACHE,
    QUEUE,
    JOB_HANDLER_REGISTRY,
    JOB_OBSERVER,
    QUEUE_INSPECTOR,
    CLOCK,
    TOKEN_GENERATOR,
    THROTTLER_STORAGE,
    SECRET_BOX,
    READINESS_CHECKS,
  ],
})
export class CoreInfrastructureModule {}
