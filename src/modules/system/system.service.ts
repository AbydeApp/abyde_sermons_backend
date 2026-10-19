import { timingSafeEqual } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { defineJobHandler, JOB_HANDLER_REGISTRY, type JobHandlerRegistry } from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { EMAIL_SENDER, type EmailMessage, type EmailSenderPort } from '../../shared/application/ports/email.port.js';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { AI_USAGE_RECORDER, type AIUsageRecorderPort } from '../../shared/application/ports/usage-meter.port.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import { MetricsService } from '../../shared/infrastructure/observability/metrics.service.js';
import { SUBSCRIPTION_REPOSITORY, type SubscriptionRepositoryPort } from '../billing/billing.repository.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { QUEUE_INSPECTOR, type QueueInspector } from './adapters/queue-inspector.js';
import {
  AI_USAGE_LOG_RETENTION_DAYS, heapTooHighMessage, heapWarning, judgeHeapLimit, PURGE_OLD_RECORDS_EVERY_MS,
  PURGE_OLD_RECORDS_JOB, PURGE_UPLOADS_EVERY_MS, PURGE_UPLOADS_JOB, readContainerMemoryLimit, retentionCutoff,
  SEND_EMAIL_JOB, WEBHOOK_EVENT_RETENTION_DAYS,
} from './helper.js';

/** Email delivery and housekeeping jobs, the boot-time heap check, and the metrics scrape. */
@Injectable()
export class SystemService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(EMAIL_SENDER) private readonly email: EmailSenderPort,
    @Inject(SUBSCRIPTION_REPOSITORY) private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(AI_USAGE_RECORDER) private readonly aiUsage: AIUsageRecorderPort,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(QUEUE_INSPECTOR) private readonly queues: QueueInspector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(defineJobHandler<EmailMessage>(SEND_EMAIL_JOB, (message) => this.email.send(message)));
    this.registry.register(
      defineJobHandler(PURGE_UPLOADS_JOB, async (_payload, context) => void (await this.uploads.purgeStale(context))),
    );
    this.registry.registerRecurring({
      queue: PURGE_UPLOADS_JOB.queue,
      jobName: PURGE_UPLOADS_JOB.name,
      everyMs: PURGE_UPLOADS_EVERY_MS,
    });
    this.registry.register(defineJobHandler(PURGE_OLD_RECORDS_JOB, async () => void (await this.purgeOldRecords())));
    this.registry.registerRecurring({
      queue: PURGE_OLD_RECORDS_JOB.queue,
      jobName: PURGE_OLD_RECORDS_JOB.name,
      everyMs: PURGE_OLD_RECORDS_EVERY_MS,
    });
  }

  /**
   * Checks at boot that the V8 heap limit fits the container. If the heap may grow past the
   * container limit, a leak ends in a silent kernel kill (exit 137) instead of a heap error with a
   * stack trace, so a deployed environment refuses to start that way.
   */
  async onApplicationBootstrap(): Promise<void> {
    const heapLimit = getHeapStatistics().heap_size_limit;
    const containerLimit = await readContainerMemoryLimit();
    const verdict = judgeHeapLimit(heapLimit, containerLimit);
    const details = {
      heapLimitMb: Math.round(heapLimit / 1024 ** 2),
      containerLimitMb: containerLimit === null ? null : Math.round(containerLimit / 1024 ** 2),
    };
    if (verdict === 'ok' || verdict === 'unlimited') return;
    const deployed = this.config.APP_ENV === 'production' || this.config.APP_ENV === 'staging';
    if (verdict === 'too-high' && deployed) throw new Error(heapTooHighMessage(details.heapLimitMb, details.containerLimitMb));
    this.logger.warn(details, heapWarning(verdict));
  }

  /** Keeps append-only operational tables bounded. */
  async purgeOldRecords(): Promise<{ webhookEvents: number; aiUsageLogs: number }> {
    const now = this.clock.now();
    return {
      webhookEvents: await this.subscriptions.deleteWebhookEventsBefore(retentionCutoff(now, WEBHOOK_EVENT_RETENTION_DAYS)),
      aiUsageLogs: await this.aiUsage.deleteBefore(retentionCutoff(now, AI_USAGE_LOG_RETENTION_DAYS)),
    };
  }

  /**
   * Prometheus text for the scrape endpoint. Requires the metrics bearer token when configured;
   * without a token it is served only in local development and test. Anything else is a 404.
   */
  async scrape(authorization: string | undefined): Promise<{ contentType: string; body: string }> {
    const token = this.config.OBSERVABILITY_METRICS_TOKEN;
    if (token) {
      const presented = Buffer.from(authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(token);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw notFound('Resource');
    } else if (this.config.APP_ENV !== 'development' && this.config.APP_ENV !== 'test') {
      throw notFound('Resource');
    }
    for (const queue of Object.values(QUEUES)) {
      const counts = await this.queues.counts(queue).catch(() => null);
      for (const [state, value] of Object.entries(counts ?? {})) this.metrics.queueDepth.set({ queue, state }, value);
    }
    return { contentType: this.metrics.registry.contentType, body: await this.metrics.registry.metrics() };
  }
}
