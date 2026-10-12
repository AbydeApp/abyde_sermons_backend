import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { LoggerModule } from 'nestjs-pino';
import { CoreInfrastructureModule } from './composition/core-infrastructure.module.js';
import { ExternalProvidersModule } from './composition/external-providers.module.js';
import { PrismaPersistenceModule } from './composition/prisma-persistence.module.js';
import { THROTTLER_STORAGE } from './composition/tokens.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { BrandModule } from './modules/brand/brand.module.js';
import { ChurchModule } from './modules/church/church.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { LibraryModule } from './modules/library/library.module.js';
import { PublishingModule } from './modules/publishing/publishing.module.js';
import { ReelsModule } from './modules/reels/reels.module.js';
import { SermonsModule } from './modules/sermons/sermons.module.js';
import { SocialModule } from './modules/social/social.module.js';
import { SystemModule } from './modules/system/system.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import {
  APP_CONFIG,
  ConfigModule,
} from './shared/infrastructure/config/config.module.js';
import type { AppConfig } from './shared/infrastructure/config/env.schema.js';
import { ErrorEnvelopeFilter } from './shared/infrastructure/http/error-envelope.filter.js';
import { IdempotencyInterceptor } from './shared/infrastructure/http/idempotency.interceptor.js';
import { HttpMetricsInterceptor } from './shared/infrastructure/observability/http-metrics.interceptor.js';

type ModuleRef = Type | DynamicModule;

/** Pretty logs only in development and only when the dev-only formatter is installed (never in images). */
function prettyTransport(env: string): { target: string } | undefined {
  if (env !== 'development') return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

/** Production adapters. Tests pass an in-memory set instead (see test/support). */
export const PRODUCTION_INFRASTRUCTURE: ModuleRef[] = [
  CoreInfrastructureModule,
  PrismaPersistenceModule,
  ExternalProvidersModule,
];

const BUSINESS_MODULES: ModuleRef[] = [
  AuthModule,
  ChurchModule,
  UploadsModule,
  SermonsModule,
  ContentModule,
  LibraryModule,
  BillingModule,
  IntegrationsModule,
  PublishingModule,
  BrandModule,
  SocialModule,
  ReelsModule,
  AnalyticsModule,
  HealthModule,
  SystemModule,
];

@Module({})
export class AppModule {
  static register(
    options: {
      infrastructure?: ModuleRef[];
      extraProviders?: DynamicModule['providers'];
    } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(),
        ...(options.infrastructure ?? PRODUCTION_INFRASTRUCTURE),
        LoggerModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => ({
            pinoHttp: {
              level: config.APP_LOG_LEVEL,
              genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id =
                  typeof incoming === 'string' &&
                  /^[A-Za-z0-9-]{8,128}$/.test(incoming)
                    ? incoming
                    : randomUUID();
                res.setHeader('x-request-id', id);
                return id;
              },
              // Never log credentials, cookies or bodies (which can contain sermon text).
              redact: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.headers["x-paystack-signature"]',
              ],
              serializers: {
                req: (req: { id: string; method: string; url: string }) => ({
                  id: req.id,
                  method: req.method,
                  url: req.url?.split('?')[0],
                }),
              },
              autoLogging: {
                ignore: (req) =>
                  req.url?.startsWith('/health') === true ||
                  req.url?.startsWith('/metrics') === true,
              },
              transport: prettyTransport(config.APP_ENV),
            },
          }),
        }),
        ThrottlerModule.forRootAsync({
          inject: [APP_CONFIG, THROTTLER_STORAGE],
          useFactory: (config: AppConfig, storage: ThrottlerStorage) => ({
            throttlers: [
              {
                name: 'default',
                ttl: config.APP_RATE_LIMIT_TTL_MS,
                limit: config.APP_RATE_LIMIT_MAX,
              },
            ],
            storage,
          }),
        }),
        ...BUSINESS_MODULES,
      ],
      providers: [
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        ...(options.extraProviders ?? []),
      ],
    };
  }
}
