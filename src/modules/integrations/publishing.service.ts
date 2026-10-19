import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { checkpoint, defineJobHandler, JOB_HANDLER_REGISTRY, type JobContext, type JobHandlerRegistry, type RunGuard } from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { QUEUE, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { newId } from '../../shared/domain/id.js';
import {
  CALENDAR_REPOSITORY, type CalendarRepositoryPort, CONTENT_REPOSITORY, type ContentRepositoryPort,
} from '../content/content.repository.js';
import { PUBLISHING_PROVIDERS, type PublishingProviderPort, type PublishResult } from './adapters/ports.js';
import {
  AUTO_PUBLISHED_TYPES, CHANNEL_FOR_TYPE, connectMessage, DISPATCH_BATCH, DISPATCH_EVERY_MS, DISPATCH_JOB,
  MANUAL_TYPE_MESSAGE, PUBLISH_JOB, type PublishJobPayload, reconnectMessage, rejectedMessage, STALE_PUBLISHING_MS,
  unconfirmedMessage,
} from './helper.js';
import { IntegrationsService } from './integrations.service.js';
import { PUBLISHING_REPOSITORY, type PublishingRepositoryPort } from './integrations.repository.js';

/** Publishes calendar items that are due, exactly once, through the church's connected integrations. */
@Injectable()
export class PublishingService implements OnModuleInit {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    @Inject(PUBLISHING_REPOSITORY) private readonly publishing: PublishingRepositoryPort,
    @Inject(PUBLISHING_PROVIDERS) private readonly providers: PublishingProviderPort[],
    @Inject(CALENDAR_REPOSITORY) private readonly calendar: CalendarRepositoryPort,
    @Inject(CONTENT_REPOSITORY) private readonly contents: ContentRepositoryPort,
    @Inject(IntegrationsService) private readonly integrations: IntegrationsService,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(defineJobHandler(DISPATCH_JOB, async (_payload, context) => void (await this.dispatchDue(context))));
    this.registry.register(defineJobHandler<PublishJobPayload>(PUBLISH_JOB, (payload, context) => this.publish(payload, context)));
    this.registry.registerRecurring({ queue: DISPATCH_JOB.queue, jobName: DISPATCH_JOB.name, everyMs: DISPATCH_EVERY_MS });
  }

  /** Runs every minute: claims due calendar items and enqueues one idempotent publish job each. */
  async dispatchDue(guard?: RunGuard): Promise<number> {
    const now = this.clock.now();
    await checkpoint(guard);
    const released = await this.publishing.releaseStale(new Date(now.getTime() - STALE_PUBLISHING_MS));
    if (released > 0) this.logger.warn({ released }, 'Released stale publishing claims');
    const due = await this.publishing.claimDue(now, AUTO_PUBLISHED_TYPES, DISPATCH_BATCH);
    for (const item of due) {
      // Stop if this run was aborted or a newer holder took over; unclaimed items are released later.
      await checkpoint(guard);
      const payload: PublishJobPayload = { ...item, scheduledAt: item.scheduledAt.toISOString() };
      await this.queue.enqueue(PUBLISH_JOB.queue, PUBLISH_JOB.name, payload, {
        // Unique per claim: a retained (completed/failed) job with the same id would make BullMQ
        // drop this enqueue silently. Exactly-once posting is enforced by publish_attempts instead.
        jobId: `publish:${item.calendarItemId}:${now.getTime()}`,
      });
    }
    return due.length;
  }

  /**
   * Publishes one calendar item exactly once. The idempotency key (calendar item + scheduled time)
   * is unique in publish_attempts; an attempt whose outcome is unknown (timeout, crash) is never
   * retried automatically, because a duplicate public post is worse than a visible failure.
   */
  async publish(payload: PublishJobPayload, context: JobContext): Promise<void> {
    const entry = await this.calendar.findById(payload.churchId, payload.calendarItemId);
    if (!entry || entry.status !== 'PUBLISHING' || entry.scheduledAt.toISOString() !== payload.scheduledAt) return;
    const item = await this.contents.findById(payload.churchId, payload.contentItemId);
    if (!item) return;
    const provider = CHANNEL_FOR_TYPE[item.type];
    if (!provider) return this.fail(payload, MANUAL_TYPE_MESSAGE);

    // Pre-flight first: nothing here talks to the provider, so a failure is safely retryable and
    // must not leave a PENDING attempt behind (which would be read as "outcome unknown").
    const adapter = this.providers.find((candidate) => candidate.provider === provider);
    const credentials = await this.integrations.credentialsFor(payload.churchId, provider);
    if (!credentials || !adapter) return this.fail(payload, connectMessage(provider));

    const idempotencyKey = `${payload.calendarItemId}:${payload.scheduledAt}`;
    const existing = await this.publishing.findAttempt(idempotencyKey);
    if (existing?.status === 'SUCCEEDED') return this.succeed(payload);
    let attemptId: string;
    if (existing?.status === 'PENDING') {
      // A previous run reached the provider call but never recorded the outcome: do not risk a duplicate post.
      await this.publishing.completeAttempt(existing.id, {
        status: 'FAILED',
        errorMessage: 'Outcome unknown after interruption',
        definite: false,
      });
      return this.fail(payload, unconfirmedMessage(provider));
    }
    if (existing) {
      // Outcome of the earlier attempt is unknown: never post again automatically.
      if (!(await this.publishing.reopenAttempt(existing.id))) return this.fail(payload, unconfirmedMessage(provider));
      attemptId = existing.id;
    } else {
      attemptId = newId();
      const created = await this.publishing.createAttempt({
        id: attemptId,
        churchId: payload.churchId,
        contentItemId: payload.contentItemId,
        provider,
        idempotencyKey,
        status: 'PENDING',
        externalId: null,
        errorMessage: null,
      });
      if (!created) return; // another worker holds this idempotency key
    }

    // The only non-idempotent step. An adapter that throws is treated as "outcome unknown".
    const result = await adapter
      .publish({ idempotencyKey, credentials, content: { type: item.type, title: item.title, body: item.body } })
      .catch((error: unknown): PublishResult => ({
        ok: false,
        retryable: false,
        definite: false,
        credentialsInvalid: false,
        message: `Adapter error: ${(error as Error).message}`,
      }));
    if (result.ok) {
      // The post is live: recording that must not be lost to a transient database error.
      await this.withRetries(() =>
        this.publishing.completeAttempt(attemptId, { status: 'SUCCEEDED', externalId: result.externalId }),
      );
      return this.withRetries(() => this.succeed(payload));
    }
    await this.publishing.completeAttempt(attemptId, {
      status: 'FAILED',
      errorMessage: result.message.slice(0, 500),
      definite: result.definite,
    });
    if (result.credentialsInvalid) await this.integrations.markNeedsAttention(payload.churchId, provider);
    if (result.definite && result.retryable && !context.isFinalAttempt) {
      throw new Error(`Retryable publish failure: ${result.message}`); // queue retries with backoff
    }
    this.logger.warn({ calendarItemId: payload.calendarItemId, provider, message: result.message }, 'Publishing failed');
    return this.fail(
      payload,
      result.credentialsInvalid
        ? reconnectMessage(provider)
        : result.definite
          ? rejectedMessage(provider)
          : unconfirmedMessage(provider),
    );
  }

  private async withRetries<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  private async succeed(payload: PublishJobPayload): Promise<void> {
    await this.uow.run(async () => {
      const item = await this.contents.findById(payload.churchId, payload.contentItemId);
      if (item) {
        item.markPublished(this.clock.now());
        await this.contents.save(item);
      }
      await this.publishing.setCalendarStatus(payload.churchId, payload.calendarItemId, 'PUBLISHED');
    });
  }

  private async fail(payload: PublishJobPayload, reason: string): Promise<void> {
    await this.uow.run(async () => {
      const item = await this.contents.findById(payload.churchId, payload.contentItemId);
      if (item && item.status !== 'PUBLISHED') {
        item.markPublishFailed(this.clock.now());
        await this.contents.save(item);
      }
      await this.publishing.setCalendarStatus(payload.churchId, payload.calendarItemId, 'FAILED');
    });
    this.logger.log({ calendarItemId: payload.calendarItemId, reason }, 'Calendar item marked failed');
  }
}
