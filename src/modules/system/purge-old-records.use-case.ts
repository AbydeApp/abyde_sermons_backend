import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../shared/application/ports/clock.port.js';
import {
  AI_USAGE_RECORDER,
  type AIUsageRecorderPort,
} from '../../shared/application/ports/usage-meter.port.js';
import { SUBSCRIPTION_REPOSITORY, type SubscriptionRepositoryPort } from '../billing/billing.repository.js';

const DAY_MS = 24 * 3600 * 1000;
/** Webhook records only guard against replays; providers stop redelivering within days. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 90;
/** AI cost logs feed unit-economics reporting; thirteen months keeps a full year-on-year comparison. */
export const AI_USAGE_LOG_RETENTION_DAYS = 400;

/** Maintenance: keeps append-only operational tables bounded. */
@Injectable()
export class PurgeOldRecordsUseCase {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(AI_USAGE_RECORDER) private readonly aiUsage: AIUsageRecorderPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<{ webhookEvents: number; aiUsageLogs: number }> {
    const now = this.clock.now().getTime();
    return {
      webhookEvents: await this.subscriptions.deleteWebhookEventsBefore(
        new Date(now - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS),
      ),
      aiUsageLogs: await this.aiUsage.deleteBefore(
        new Date(now - AI_USAGE_LOG_RETENTION_DAYS * DAY_MS),
      ),
    };
  }
}
