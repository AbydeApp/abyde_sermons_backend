import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  DomainError,
  notFound,
  validationError,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type {
  Page,
  PageRequest,
} from '../../../../shared/domain/pagination.js';
import {
  CONTENT_REPOSITORY,
  type ContentRepositoryPort,
} from '../../../content/content.repository.js';
import type { SocialPlatform } from '../../domain/social-platform.js';
import {
  assertDeletable,
  assertEditable,
  derivePostStatus,
  isValidTimeZone,
  retryablePublications,
  type SocialPost,
  type SocialPostAggregate,
  type SocialPublication,
  startablePublications,
  validateScheduleTime,
} from '../../domain/social-post.js';
import { validateTargetSettings } from '../../domain/target-settings.js';
import { PostValidator } from '../post-validator.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  SOCIAL_POST_REPOSITORY,
  type SocialAuditLogPort,
  type SocialConnectionRepositoryPort,
  type SocialPostFilter,
  type SocialPostRepositoryPort,
} from '../ports/out/social-repositories.port.js';
import type { Actor } from './connection.use-cases.js';
import { PublicationDispatcher, postLock } from './publishing.use-cases.js';

export interface PostTarget {
  platform: SocialPlatform;
  connectionId: string;
  settings?: Record<string, unknown>;
}

export interface SocialPostInput {
  /** The generated content the post comes from; absent for posts made from a Reel. */
  contentId?: string;
  caption: string;
  title?: string;
  mediaAssetIds: string[];
  thumbnailAssetId?: string;
  targets: PostTarget[];
}

export interface PostResult {
  aggregate: SocialPostAggregate;
  mediaPending: boolean;
}

/** Shared validation for create and update: content, media, targets and platform capabilities. */
@Injectable()
export class SocialPostPlanner {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(PostValidator) private readonly validator: PostValidator,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async plan(
    actor: Actor,
    input: SocialPostInput,
    postId: string,
  ): Promise<{ publications: SocialPublication[]; mediaPending: boolean }> {
    if (
      input.contentId !== undefined &&
      !(await this.contents.findById(actor.churchId, input.contentId))
    )
      throw validationError('contentId', 'Content not found');
    const media = await this.validator.loadMedia(
      actor.churchId,
      input.mediaAssetIds,
      input.thumbnailAssetId,
    );
    const connections = await this.connections.findByIds(
      actor.churchId,
      input.targets.map((target) => target.connectionId),
    );
    this.validator.checkTargets(input.targets, connections);
    await this.validator.checkCapabilities(
      input,
      media.assets,
      input.targets.map((target) => target.platform),
    );
    const now = this.clock.now();
    return {
      mediaPending: media.pending,
      publications: input.targets.map((target) => ({
        id: newId(),
        churchId: actor.churchId,
        socialPostId: postId,
        connectionId: target.connectionId,
        platform: target.platform,
        status: 'pending',
        attemptCount: 0,
        pollCount: 0,
        outcomeUnknown: false,
        settings: validateTargetSettings(
          target.platform,
          target.settings ?? {},
        ),
        providerMetadata: {},
        createdAt: now,
        updatedAt: now,
      })),
    };
  }
}

const normalise = (input: SocialPostInput): SocialPostInput => ({
  ...input,
  caption: input.caption.trim(),
  title: input.title?.trim() || undefined,
});

@Injectable()
export class CreateSocialPostUseCase {
  constructor(
    @Inject(SocialPostPlanner) private readonly planner: SocialPostPlanner,
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(actor: Actor, raw: SocialPostInput): Promise<PostResult> {
    const input = normalise(raw);
    const id = newId();
    const { publications, mediaPending } = await this.planner.plan(
      actor,
      input,
      id,
    );
    const now = this.clock.now();
    const post: SocialPost = {
      id,
      churchId: actor.churchId,
      contentId: input.contentId ?? null,
      caption: input.caption,
      title: input.title,
      mediaAssetIds: input.mediaAssetIds,
      thumbnailAssetId: input.thumbnailAssetId,
      status: publications.length > 0 ? 'ready' : 'draft',
      createdByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    const aggregate = { post, publications };
    await this.posts.create(aggregate);
    await this.audit.record({
      churchId: actor.churchId,
      userId: actor.userId,
      action: 'post.created',
      socialPostId: id,
      detail: { targets: publications.length },
    });
    return { aggregate, mediaPending };
  }
}

@Injectable()
export class UpdateSocialPostUseCase {
  constructor(
    @Inject(SocialPostPlanner) private readonly planner: SocialPostPlanner,
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Full replacement of content and targets; a scheduled post keeps its schedule. */
  async execute(
    actor: Actor,
    id: string,
    raw: SocialPostInput,
  ): Promise<PostResult> {
    const input = normalise(raw);
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    assertEditable(current);
    const { publications, mediaPending } = await this.planner.plan(
      actor,
      input,
      id,
    );
    const scheduled = current.post.status === 'scheduled';
    return this.uow.runLocked(postLock(id), async () => {
      const locked = await this.posts.find(actor.churchId, id);
      if (!locked) throw notFound('Post');
      assertEditable(locked);
      const targets = publications.map((publication) => ({
        ...publication,
        status: scheduled ? ('scheduled' as const) : ('pending' as const),
      }));
      const post: SocialPost = {
        ...locked.post,
        contentId: input.contentId ?? null,
        caption: input.caption,
        title: input.title,
        mediaAssetIds: input.mediaAssetIds,
        thumbnailAssetId: input.thumbnailAssetId,
        status: scheduled
          ? 'scheduled'
          : targets.length > 0
            ? 'ready'
            : 'draft',
        updatedAt: this.clock.now(),
      };
      await this.posts.updatePost(post);
      await this.posts.replacePublications(actor.churchId, id, targets);
      return { aggregate: { post, publications: targets }, mediaPending };
    });
  }
}

@Injectable()
export class GetSocialPostUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(PostValidator) private readonly validator: PostValidator,
  ) {}

  async execute(churchId: string, id: string): Promise<PostResult> {
    const aggregate = await this.posts.find(churchId, id);
    if (!aggregate) throw notFound('Post');
    const media = await this.validator
      .loadMedia(churchId, aggregate.post.mediaAssetIds)
      .catch(() => ({ pending: false }));
    return { aggregate, mediaPending: media.pending };
  }
}

@Injectable()
export class ListSocialPostsUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
  ) {}

  execute(
    churchId: string,
    filter: SocialPostFilter,
    page: PageRequest,
  ): Promise<Page<SocialPostAggregate>> {
    return this.posts.list(churchId, filter, page);
  }
}

@Injectable()
export class DeleteSocialPostUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  /** Idempotent for posts that are already gone. Never removes anything from a platform. */
  async execute(actor: Actor, id: string): Promise<void> {
    await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) return;
      assertDeletable(aggregate);
      await this.posts.delete(actor.churchId, id);
      await this.audit.record({
        churchId: actor.churchId,
        userId: actor.userId,
        action: 'post.deleted',
        socialPostId: id,
      });
    });
  }
}

/** Re-checks a post right before it is queued: capabilities and media may have changed. */
@Injectable()
export class PrePublishCheck {
  constructor(
    @Inject(PostValidator) private readonly validator: PostValidator,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
  ) {}

  async run(
    churchId: string,
    aggregate: SocialPostAggregate,
    publications: SocialPublication[],
    options: { requireMediaReady: boolean },
  ): Promise<void> {
    const media = await this.validator.loadMedia(
      churchId,
      aggregate.post.mediaAssetIds,
      aggregate.post.thumbnailAssetId,
    );
    if (options.requireMediaReady && media.pending)
      throw new DomainError(
        'CONFLICT',
        'MEDIA_NOT_READY',
        'The media for this post is still rendering. Try again in a moment, or schedule it.',
      );
    const connections = await this.connections.findByIds(
      churchId,
      publications.map((publication) => publication.connectionId),
    );
    this.validator.checkTargets(publications, connections);
    await this.validator.checkCapabilities(
      aggregate.post,
      media.assets,
      publications.map((publication) => publication.platform),
    );
  }
}

@Injectable()
export class PublishSocialPostUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(PrePublishCheck) private readonly check: PrePublishCheck,
    @Inject(PublicationDispatcher)
    private readonly dispatcher: PublicationDispatcher,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Queues one independent job per target and returns at once. */
  async execute(actor: Actor, id: string): Promise<SocialPostAggregate> {
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.check.run(
      actor.churchId,
      current,
      startablePublications(current),
      {
        requireMediaReady: true,
      },
    );
    const queued = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const startable = startablePublications(aggregate);
      const moved: SocialPublication[] = [];
      for (const publication of startable) {
        if (
          await this.posts.transitionPublication(
            actor.churchId,
            publication.id,
            ['pending', 'scheduled'],
            {
              status: 'queued',
            },
          )
        )
          moved.push(publication);
      }
      await this.posts.updatePost({
        ...aggregate.post,
        scheduledAt: undefined,
        timezone: undefined,
        status: 'queued',
        updatedAt: this.clock.now(),
      });
      return moved;
    });
    await this.audit.record({
      churchId: actor.churchId,
      userId: actor.userId,
      action: 'post.publish_requested',
      socialPostId: id,
      detail: { targets: queued.length },
    });
    await this.dispatcher.enqueue(queued);
    await this.dispatcher.recompute(actor.churchId, id);
    return (await this.posts.find(actor.churchId, id)) as SocialPostAggregate;
  }
}

@Injectable()
export class ScheduleSocialPostUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(PrePublishCheck) private readonly check: PrePublishCheck,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Re-scheduling a scheduled post moves it; media may still be rendering at this point. */
  async execute(
    actor: Actor,
    id: string,
    input: { scheduledAt: Date; timezone?: string },
  ): Promise<SocialPostAggregate> {
    validateScheduleTime(input.scheduledAt, this.clock.now());
    if (input.timezone && !isValidTimeZone(input.timezone))
      throw validationError('timezone', 'Unknown time zone');
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.check.run(
      actor.churchId,
      current,
      startablePublications(current),
      {
        requireMediaReady: false,
      },
    );
    const scheduled = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const startable = startablePublications(aggregate);
      for (const publication of startable)
        await this.posts.transitionPublication(
          actor.churchId,
          publication.id,
          ['pending', 'scheduled'],
          {
            status: 'scheduled',
          },
        );
      const post: SocialPost = {
        ...aggregate.post,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        updatedAt: this.clock.now(),
      };
      const publications = aggregate.publications.map((publication) =>
        startable.includes(publication)
          ? { ...publication, status: 'scheduled' as const }
          : publication,
      );
      post.status = derivePostStatus(post, publications);
      await this.posts.updatePost(post);
      return { post, publications };
    });
    await this.audit.record({
      churchId: actor.churchId,
      userId: actor.userId,
      action: 'post.scheduled',
      socialPostId: id,
      detail: {
        scheduledAt: input.scheduledAt.toISOString(),
        timezone: input.timezone ?? null,
      },
    });
    return scheduled;
  }
}

@Injectable()
export class RetrySocialPostUseCase {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY)
    private readonly posts: SocialPostRepositoryPort,
    @Inject(PrePublishCheck) private readonly check: PrePublishCheck,
    @Inject(PublicationDispatcher)
    private readonly dispatcher: PublicationDispatcher,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(
    actor: Actor,
    id: string,
    options: { publicationIds?: string[]; confirmNotPublished: boolean },
  ): Promise<SocialPostAggregate> {
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.check.run(
      actor.churchId,
      current,
      retryablePublications(current, options),
      {
        requireMediaReady: true,
      },
    );
    const queued = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const moved: SocialPublication[] = [];
      for (const publication of retryablePublications(aggregate, options)) {
        if (
          await this.posts.transitionPublication(
            actor.churchId,
            publication.id,
            ['failed'],
            {
              status: 'queued',
              outcomeUnknown: false,
              lastErrorCode: undefined,
              lastErrorMessage: undefined,
              providerRef: undefined,
              pollCount: 0,
            },
          )
        )
          moved.push(publication);
      }
      return moved;
    });
    await this.audit.record({
      churchId: actor.churchId,
      userId: actor.userId,
      action: 'post.retry_requested',
      socialPostId: id,
      detail: {
        targets: queued.length,
        confirmedNotPublished: options.confirmNotPublished,
      },
    });
    await this.dispatcher.enqueue(queued);
    await this.dispatcher.recompute(actor.churchId, id);
    return (await this.posts.find(actor.churchId, id)) as SocialPostAggregate;
  }
}
