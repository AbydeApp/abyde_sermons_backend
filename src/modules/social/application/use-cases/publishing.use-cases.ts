import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  checkpoint,
  type JobContext,
  type RunGuard,
} from '../../../../shared/application/jobs.js';
import {
  USAGE_METER,
  type UsageMeterPort,
} from '../../../../shared/application/ports/usage-meter.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  QUEUE,
  QUEUES,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import { newId } from '../../../../shared/domain/id.js';
import type { SocialConnection } from '../../domain/social-connection.js';
import {
  asSocialProviderError,
  SocialProviderError,
} from '../../domain/social-errors.js';
import {
  derivePostStatus,
  type PublicationStatus,
  type SocialPost,
  type SocialPublication,
  titleFor,
} from '../../domain/social-post.js';
import { ConnectionAccessService } from '../connection-access.service.js';
import { PostValidator } from '../post-validator.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  SOCIAL_POST_REPOSITORY,
  type SocialAuditLogPort,
  type SocialConnectionRepositoryPort,
  type SocialPostRepositoryPort,
} from '../ports/out/social-repositories.port.js';
import {
  type PublishInput,
  type PublishMedia,
  type PublishOutcome,
  SOCIAL_PROVIDER_REGISTRY,
  type SocialProviderRegistryPort,
} from '../ports/out/social-publishing.port.js';
import {
  type PublishableAsset,
  SOCIAL_MEDIA_LIBRARY,
  SOCIAL_OBSERVER,
  SOCIAL_SETTINGS,
  type SocialMediaLibraryPort,
  type SocialObserverPort,
  type SocialSettings,
} from '../ports/out/social-support.ports.js';

/** `social-publish` job: one per publication (target), so platforms fail independently. */
export interface SocialPublishJob {
  publicationId: string;
  churchId: string;
  connectionId: string;
}

export interface SocialStatusJob {
  publicationId: string;
  churchId: string;
  pollCount: number;
}

export const PUBLISH_PUBLICATION_JOB = {
  queue: QUEUES.SOCIAL_PUBLISH,
  name: 'publish',
} as const;
export const DISPATCH_SOCIAL_JOB = {
  queue: QUEUES.SOCIAL_PUBLISH,
  name: 'dispatch-due',
} as const;
export const CHECK_PUBLICATION_JOB = {
  queue: QUEUES.SOCIAL_STATUS,
  name: 'check',
} as const;
export const REFRESH_TOKENS_JOB = {
  queue: QUEUES.TOKEN_MAINTENANCE,
  name: 'refresh-expiring',
} as const;
export const COLLECT_METRICS_JOB = {
  queue: QUEUES.SOCIAL_METRICS,
  name: 'collect',
} as const;

export const postLock = (postId: string) => `social-post:${postId}`;

const DISPATCH_BATCH = 100;
/** Longer than the queue's whole retry backoff, so a publication waiting on a retry is left alone. */
const STALE_QUEUED_MS = 30 * 60 * 1000;
/** Longer than a social-publish attempt may run: a publication still publishing has lost its worker. */
const STALE_PUBLISHING_MS = 30 * 60 * 1000;
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const MAX_STATUS_POLLS = 120;
const MAX_POLL_DELAY_SECONDS = 300;
const TOKEN_LOOKAHEAD_MS = 2 * 3600 * 1000;
const METRICS_WINDOW_MS = 30 * 24 * 3600 * 1000;
const METRICS_STALE_MS = 6 * 3600 * 1000;

/** Queues publication jobs and keeps each post's status in line with its publications. */
@Injectable()
export class PublicationDispatcher {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async enqueue(
    publications: Array<
      Pick<SocialPublication, 'id' | 'churchId' | 'connectionId'>
    >,
  ): Promise<void> {
    for (const publication of publications) {
      const payload: SocialPublishJob = {
        publicationId: publication.id,
        churchId: publication.churchId,
        connectionId: publication.connectionId,
      };
      // Unique per enqueue: BullMQ silently drops an id matching a retained job (a retry would
      // vanish). Exactly-once posting rests on the queued → publishing claim, not on job ids.
      await this.queue.enqueue(
        PUBLISH_PUBLICATION_JOB.queue,
        PUBLISH_PUBLICATION_JOB.name,
        payload,
        {
          jobId: `social-publish:${publication.id}:${newId()}`,
        },
      );
    }
  }

  async enqueueCheck(
    publication: Pick<SocialPublication, 'id' | 'churchId'>,
    pollCount: number,
    delaySeconds: number,
  ): Promise<void> {
    const payload: SocialStatusJob = {
      publicationId: publication.id,
      churchId: publication.churchId,
      pollCount,
    };
    await this.queue.enqueue(
      CHECK_PUBLICATION_JOB.queue,
      CHECK_PUBLICATION_JOB.name,
      payload,
      {
        jobId: `social-status:${publication.id}:${pollCount}`,
        delayMs: delaySeconds * 1000,
      },
    );
  }

  /** Serialised per post, so concurrent workers finishing different platforms agree on the result. */
  async recompute(churchId: string, postId: string): Promise<void> {
    await this.uow.runLocked(postLock(postId), async () => {
      const aggregate = await this.posts.find(churchId, postId);
      if (!aggregate) return;
      const status = derivePostStatus(aggregate.post, aggregate.publications);
      if (status !== aggregate.post.status)
        await this.posts.updatePost({
          ...aggregate.post,
          status,
          updatedAt: this.clock.now(),
        });
    });
  }
}

/**
 * Worker steps:
 * 1. load publication, 2. load connection, 3. decrypt token just in time (refreshing if needed),
 * 4. resolve adapter, 5. create provider-compatible media URLs, 6. publish, 7. persist the
 * provider id or the error, 8. record audit/metrics, 9. update the parent post status.
 */
@Injectable()
export class PublishPublicationUseCase {
  private readonly logger = new Logger(PublishPublicationUseCase.name);

  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
    @Inject(SOCIAL_MEDIA_LIBRARY)
    private readonly media: SocialMediaLibraryPort,
    @Inject(PostValidator) private readonly validator: PostValidator,
    @Inject(PublicationDispatcher)
    private readonly dispatcher: PublicationDispatcher,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(SOCIAL_OBSERVER) private readonly observer: SocialObserverPort,
    @Inject(SOCIAL_SETTINGS) private readonly settings: SocialSettings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
  ) {}

  async publish(payload: SocialPublishJob, context: JobContext): Promise<void> {
    const publication = await this.posts.findPublication(
      payload.churchId,
      payload.publicationId,
    );
    // Anything but `queued` was already handled (or cancelled): a duplicate job is a no-op.
    if (!publication || publication.status !== 'queued') return;
    const prepared = await this.prepare(publication, context, 'queued');
    if (!prepared) return;
    // The claim: exactly one worker moves queued → publishing and may call the provider.
    if (
      !(await this.posts.transitionPublication(
        publication.churchId,
        publication.id,
        ['queued'],
        {
          status: 'publishing',
          incrementAttempt: true,
        },
      ))
    )
      return;
    const log = this.logContext(publication, context);
    let outcome: PublishOutcome;
    const startedAt = Date.now();
    try {
      outcome = await prepared.adapter.publish(prepared.input);
    } catch (error) {
      return this.failed(
        publication,
        asSocialProviderError(error, true),
        context,
        'queued',
        prepared.connection,
        log,
      );
    }
    this.logger.log(
      { ...log, durationMs: Date.now() - startedAt, outcome: outcome.status },
      'Provider publish call finished',
    );
    await this.apply(publication, outcome, 0);
  }

  async check(payload: SocialStatusJob, context: JobContext): Promise<void> {
    const publication = await this.posts.findPublication(
      payload.churchId,
      payload.publicationId,
    );
    if (
      !publication ||
      publication.status !== 'processing' ||
      !publication.providerRef
    )
      return;
    if (payload.pollCount < publication.pollCount) return; // superseded by a newer check
    const prepared = await this.prepare(publication, context, 'processing');
    if (!prepared) return;
    const adapter = prepared.adapter;
    if (!adapter.checkPublication) {
      return this.failed(
        publication,
        new SocialProviderError(
          'UNKNOWN',
          `${adapter.provider} cannot resume publications`,
          { outcome: 'unknown' },
        ),
        context,
        'processing',
        prepared.connection,
        this.logContext(publication, context),
        true,
      );
    }
    // Claimed while checking: a check may perform the provider's final publish step.
    if (
      !(await this.posts.transitionPublication(
        publication.churchId,
        publication.id,
        ['processing'],
        {
          status: 'publishing',
        },
      ))
    )
      return;
    const log = this.logContext(publication, context);
    let outcome: PublishOutcome;
    try {
      outcome = await adapter.checkPublication({
        ...prepared.input,
        providerRef: publication.providerRef,
        providerMetadata: publication.providerMetadata,
      });
    } catch (error) {
      return this.failed(
        publication,
        asSocialProviderError(error, true),
        context,
        'processing',
        prepared.connection,
        log,
      );
    }
    await this.apply(publication, outcome, publication.pollCount + 1);
  }

  /**
   * Everything before the provider call. Nothing here can publish, so a failure is safe: a
   * transient one is retried by the queue, a permanent one fails the publication cleanly.
   */
  private async prepare(
    publication: SocialPublication,
    context: JobContext,
    status: 'queued' | 'processing',
  ): Promise<{
    adapter: ReturnType<SocialProviderRegistryPort['forPlatform']>;
    input: PublishInput;
    connection: SocialConnection;
  } | null> {
    const log = this.logContext(publication, context);
    const aggregate = await this.posts.find(
      publication.churchId,
      publication.socialPostId,
    );
    const connection = await this.connections.findById(
      publication.churchId,
      publication.connectionId,
    );
    if (!aggregate || !connection) {
      await this.failed(
        publication,
        new SocialProviderError(
          'AUTH_EXPIRED',
          'Connection or post no longer exists',
        ),
        context,
        status,
        connection ?? undefined,
        log,
        true,
      );
      return null;
    }
    try {
      const adapter = this.registry.forPlatform(publication.platform);
      const account = await this.access.authorize(connection);
      const capabilities = await this.validator.capabilitiesFor(
        publication.platform,
      );
      const input: PublishInput = {
        platform: publication.platform,
        account,
        idempotencyKey: publication.id,
        text: aggregate.post.caption,
        title:
          capabilities.maxTitleLength > 0
            ? titleFor(aggregate.post, capabilities.maxTitleLength)
            : undefined,
        ...(await this.mediaFor(aggregate.post)),
        settings: publication.settings,
        signal: context.signal,
      };
      return { adapter, input, connection };
    } catch (error) {
      await this.failed(
        publication,
        asSocialProviderError(error, false),
        context,
        status,
        connection,
        log,
        true,
      );
      return null;
    }
  }

  private async mediaFor(
    post: SocialPost,
  ): Promise<Pick<PublishInput, 'media' | 'thumbnail'>> {
    const ids = [
      ...post.mediaAssetIds,
      ...(post.thumbnailAssetId ? [post.thumbnailAssetId] : []),
    ];
    const assets = new Map(
      (await this.media.findAssets(post.churchId, ids)).map((asset) => [
        asset.id,
        asset,
      ]),
    );
    const toMedia = async (id: string): Promise<PublishMedia> => {
      const asset = assets.get(id);
      if (!asset || asset.status === 'FAILED')
        throw new SocialProviderError(
          'INVALID_MEDIA',
          `Media ${id} is missing or failed to render`,
        );
      if (asset.status === 'PENDING')
        throw new SocialProviderError(
          'PROVIDER_PROCESSING',
          `Media ${id} is still rendering`,
          { retryable: true },
        );
      return this.publishMedia(asset);
    };
    return {
      media: await Promise.all(post.mediaAssetIds.map(toMedia)),
      thumbnail: post.thumbnailAssetId
        ? await toMedia(post.thumbnailAssetId).catch(() => undefined)
        : undefined,
    };
  }

  private async publishMedia(asset: PublishableAsset): Promise<PublishMedia> {
    return {
      type: asset.contentType.startsWith('video/') ? 'video' : 'image',
      url: await this.media.deliveryUrl(
        asset.objectKey,
        this.settings.mediaUrlTtlSeconds,
      ),
      objectKey: asset.objectKey,
      mimeType: asset.contentType,
      sizeBytes: asset.sizeBytes ?? undefined,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      durationSeconds:
        asset.durationMs === null ? undefined : asset.durationMs / 1000,
    };
  }

  /** Records a successful step. Retried locally: losing "it is live" to a blip would be worse. */
  private async apply(
    publication: SocialPublication,
    outcome: PublishOutcome,
    pollCount: number,
  ): Promise<void> {
    const now = this.clock.now();
    if (outcome.status === 'published') {
      await withRetries(() =>
        this.posts.transitionPublication(
          publication.churchId,
          publication.id,
          ['publishing'],
          {
            status: 'published',
            providerPostId: outcome.providerPostId,
            permalink: outcome.permalink,
            publishedAt: now,
            providerRef: undefined,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            providerMetadata: {
              ...publication.providerMetadata,
              ...outcome.metadata,
            },
          },
        ),
      );
      this.observer.publication({
        platform: publication.platform,
        outcome: 'published',
        latencyMs: now.getTime() - publication.updatedAt.getTime(),
      });
      // Counted once per publication, however many times this step is retried.
      await this.usage.record({
        churchId: publication.churchId,
        unit: 'SOCIAL_PUBLICATION',
        quantity: 1,
        dedupeKey: `social-publication:${publication.id}`,
      });
      await this.audit.record({
        churchId: publication.churchId,
        action: 'publication.published',
        socialPostId: publication.socialPostId,
        publicationId: publication.id,
        connectionId: publication.connectionId,
        detail: {
          platform: publication.platform,
          providerPostId: outcome.providerPostId,
        },
      });
    } else {
      if (pollCount >= MAX_STATUS_POLLS) {
        await this.posts.transitionPublication(
          publication.churchId,
          publication.id,
          ['publishing'],
          {
            status: 'failed',
            lastErrorCode: 'PROVIDER_PROCESSING',
            lastErrorMessage: `Still processing after ${pollCount} checks`,
            outcomeUnknown: true,
          },
        );
        this.observer.publication({
          platform: publication.platform,
          outcome: 'failed',
          errorCode: 'PROVIDER_PROCESSING',
        });
      } else {
        await withRetries(() =>
          this.posts.transitionPublication(
            publication.churchId,
            publication.id,
            ['publishing'],
            {
              status: 'processing',
              providerRef: outcome.providerRef,
              pollCount,
              providerMetadata: {
                ...publication.providerMetadata,
                ...outcome.metadata,
              },
            },
          ),
        );
        this.observer.publication({
          platform: publication.platform,
          outcome: 'processing',
        });
        // A lost check is re-queued by the dispatcher's sweep, so this enqueue failing is not fatal.
        await this.dispatcher
          .enqueueCheck(
            publication,
            pollCount,
            Math.min(
              MAX_POLL_DELAY_SECONDS,
              Math.max(5, outcome.checkAfterSeconds) *
                (1 + Math.floor(pollCount / 10)),
            ),
          )
          .catch((error: unknown) =>
            this.logger.warn(
              { publicationId: publication.id, err: error },
              'Could not queue status check',
            ),
          );
      }
    }
    await this.dispatcher.recompute(
      publication.churchId,
      publication.socialPostId,
    );
  }

  /**
   * A retryable failure (nothing was published) goes back to its previous state and is rethrown
   * so the queue retries with backoff. Anything else is final. Credentials problems mark the
   * connection so the UI asks for a reconnect.
   */
  private async failed(
    publication: SocialPublication,
    error: SocialProviderError,
    context: JobContext,
    previous: 'queued' | 'processing',
    connection: SocialConnection | undefined,
    log: Record<string, unknown>,
    beforeClaim = false,
  ): Promise<void> {
    const from: readonly PublicationStatus[] = beforeClaim
      ? [previous]
      : ['publishing'];
    this.logger.warn(
      {
        ...log,
        errorCode: error.code,
        retryable: error.retryable,
        outcome: error.outcome,
        providerRequestId: error.providerRequestId,
        detail: error.message.slice(0, 300),
      },
      'Publication attempt failed',
    );
    if (error.retryable && !context.isFinalAttempt) {
      if (!beforeClaim)
        await this.posts.transitionPublication(
          publication.churchId,
          publication.id,
          from,
          {
            status: previous,
            lastErrorCode: error.code,
            lastErrorMessage: error.message.slice(0, 500),
          },
        );
      this.observer.publication({
        platform: publication.platform,
        outcome: 'retry',
        errorCode: error.code,
      });
      throw error;
    }
    const moved = await this.posts.transitionPublication(
      publication.churchId,
      publication.id,
      from,
      {
        status: 'failed',
        lastErrorCode: error.code,
        lastErrorMessage: error.message.slice(0, 500),
        outcomeUnknown: error.outcome === 'unknown',
      },
    );
    if (!moved) return;
    if (connection && error.code === 'AUTH_EXPIRED')
      await this.access.expire(connection, 'provider rejected token');
    this.observer.publication({
      platform: publication.platform,
      outcome: 'failed',
      errorCode: error.code,
    });
    await this.audit.record({
      churchId: publication.churchId,
      action: 'publication.failed',
      socialPostId: publication.socialPostId,
      publicationId: publication.id,
      connectionId: publication.connectionId,
      detail: {
        platform: publication.platform,
        errorCode: error.code,
        outcomeUnknown: error.outcome === 'unknown',
      },
    });
    await this.dispatcher.recompute(
      publication.churchId,
      publication.socialPostId,
    );
  }

  private logContext(publication: SocialPublication, context: JobContext) {
    return {
      provider: publication.platform,
      churchId: publication.churchId,
      publicationId: publication.id,
      socialPostId: publication.socialPostId,
      attempt: context.attempt,
      retryCount: context.attempt - 1,
    };
  }
}

async function withRetries<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/**
 * Runs every minute on one instance: promotes due scheduled targets to the publish queue and
 * sweeps up work whose worker died. Processes current state, so a missed tick needs no replay.
 */
@Injectable()
export class DispatchDueSocialPostsUseCase {
  private readonly logger = new Logger(DispatchDueSocialPostsUseCase.name);

  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(PublicationDispatcher)
    private readonly dispatcher: PublicationDispatcher,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    guard?: RunGuard,
  ): Promise<{ dispatched: number; recovered: number }> {
    const now = this.clock.now();
    await checkpoint(guard);
    const due = await this.posts.claimDue(now, DISPATCH_BATCH);
    await this.dispatcher.enqueue(
      due.map((target) => ({
        id: target.publicationId,
        churchId: target.churchId,
        connectionId: target.connectionId,
      })),
    );
    const touchedPosts = new Map(
      due.map((target) => [target.socialPostId, target.churchId]),
    );

    await checkpoint(guard);
    let recovered = 0;
    const lostQueued = await this.posts.findStale(
      'queued',
      new Date(now.getTime() - STALE_QUEUED_MS),
      DISPATCH_BATCH,
    );
    if (lostQueued.length > 0) {
      await this.posts.touch(lostQueued.map((publication) => publication.id));
      await this.dispatcher.enqueue(lostQueued);
      recovered += lostQueued.length;
    }

    await checkpoint(guard);
    const lostChecks = await this.posts.findStale(
      'processing',
      new Date(now.getTime() - STALE_PROCESSING_MS),
      DISPATCH_BATCH,
    );
    if (lostChecks.length > 0) {
      await this.posts.touch(lostChecks.map((publication) => publication.id));
      for (const publication of lostChecks)
        await this.dispatcher.enqueueCheck(
          publication,
          publication.pollCount,
          0,
        );
      recovered += lostChecks.length;
    }

    await checkpoint(guard);
    // A worker died after claiming: the provider may have published. Never retried automatically.
    for (const publication of await this.posts.findStale(
      'publishing',
      new Date(now.getTime() - STALE_PUBLISHING_MS),
      DISPATCH_BATCH,
    )) {
      if (
        await this.posts.transitionPublication(
          publication.churchId,
          publication.id,
          ['publishing'],
          {
            status: 'failed',
            lastErrorCode: 'UNKNOWN',
            lastErrorMessage: 'Worker stopped during the provider call',
            outcomeUnknown: true,
          },
        )
      ) {
        await this.audit.record({
          churchId: publication.churchId,
          action: 'publication.failed',
          socialPostId: publication.socialPostId,
          publicationId: publication.id,
          detail: {
            platform: publication.platform,
            errorCode: 'UNKNOWN',
            outcomeUnknown: true,
          },
        });
        touchedPosts.set(publication.socialPostId, publication.churchId);
        recovered++;
      }
    }
    for (const [postId, churchId] of touchedPosts)
      await this.dispatcher.recompute(churchId, postId);
    if (recovered > 0)
      this.logger.warn({ recovered }, 'Recovered stuck social publications');
    return { dispatched: due.length, recovered };
  }
}

/** Keeps tokens fresh ahead of use, and marks lapsed connections so users are asked to reconnect. */
@Injectable()
export class RefreshExpiringConnectionsUseCase {
  private readonly logger = new Logger(RefreshExpiringConnectionsUseCase.name);

  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    guard?: RunGuard,
  ): Promise<{ refreshed: number; expired: number; failed: number }> {
    const now = this.clock.now();
    const result = { refreshed: 0, expired: 0, failed: 0 };
    for (const connection of await this.connections.findExpiring(
      new Date(now.getTime() + TOKEN_LOOKAHEAD_MS),
      50,
      true,
    )) {
      await checkpoint(guard);
      try {
        await this.access.refresh(connection, { proactive: true });
        result.refreshed++;
      } catch (error) {
        if (
          error instanceof SocialProviderError &&
          error.code === 'AUTH_EXPIRED'
        )
          result.expired++;
        else {
          result.failed++;
          this.logger.warn(
            {
              connectionId: connection.id,
              provider: connection.provider,
              errorCode:
                error instanceof SocialProviderError ? error.code : 'UNKNOWN',
            },
            'Token refresh failed; will retry next run',
          );
        }
      }
    }
    for (const connection of await this.connections.findExpiring(
      now,
      200,
      false,
    )) {
      await checkpoint(guard);
      await this.access.expire(connection, 'token lifetime ended');
      result.expired++;
    }
    return result;
  }
}

/** Refreshes engagement counters for recent publications on providers that report them. */
@Injectable()
export class CollectPublicationMetricsUseCase {
  private readonly logger = new Logger(CollectPublicationMetricsUseCase.name);

  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    const now = this.clock.now();
    let collected = 0;
    for (const publication of await this.posts.findForMetrics(
      new Date(now.getTime() - METRICS_WINDOW_MS),
      new Date(now.getTime() - METRICS_STALE_MS),
      50,
    )) {
      await checkpoint(guard);
      const adapter = this.registry.forPlatform(publication.platform);
      const connection = await this.connections.findById(
        publication.churchId,
        publication.connectionId,
      );
      if (
        !adapter.getMetrics ||
        !connection ||
        connection.status !== 'connected' ||
        !publication.providerPostId
      ) {
        await this.posts.saveMetrics(
          publication.churchId,
          publication.id,
          publication.metrics ?? {},
          now,
        );
        continue;
      }
      try {
        const metrics = await adapter.getMetrics({
          platform: publication.platform,
          account: await this.access.authorize(connection),
          providerPostId: publication.providerPostId,
          signal: guard?.signal,
        });
        await this.posts.saveMetrics(
          publication.churchId,
          publication.id,
          Object.fromEntries(
            Object.entries(metrics).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number',
            ),
          ),
          now,
        );
        collected++;
      } catch (error) {
        this.logger.warn(
          {
            publicationId: publication.id,
            provider: publication.platform,
            errorCode:
              error instanceof SocialProviderError ? error.code : 'UNKNOWN',
          },
          'Could not collect post metrics',
        );
        // Recorded as attempted so one failing post does not block the batch every run.
        await this.posts.saveMetrics(
          publication.churchId,
          publication.id,
          publication.metrics ?? {},
          now,
        );
      }
    }
    return collected;
  }
}
