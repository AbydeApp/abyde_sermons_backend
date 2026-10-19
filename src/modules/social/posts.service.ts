import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { notFound, validationError } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import type { Page, PageRequest } from '../../shared/domain/pagination.js';
import { CONTENT_REPOSITORY, type ContentRepositoryPort } from '../content/content.repository.js';
import {
  SOCIAL_MEDIA_LIBRARY, SOCIAL_PROVIDER_REGISTRY, type SocialMediaLibraryPort, type SocialProviderRegistryPort,
} from './adapters/ports.js';
import {
  type Actor, assertDeletable, assertEditable, checkCapabilities, checkTargets, derivePostStatus, invalid,
  isValidTimeZone, type MediaCheck, mediaNotReady, normalisePostInput, postLock, POSTABLE_KINDS, type PostResult,
  retryablePublications, type SocialPost, type SocialPostAggregate, type SocialPostInput, type SocialPublication,
  startablePublications, validateScheduleTime, validateTargetSettings,
} from './helper.js';
import { PublishingService } from './publishing.service.js';
import {
  SOCIAL_AUDIT_LOG, SOCIAL_CONNECTION_REPOSITORY, SOCIAL_POST_REPOSITORY, type SocialAuditLogPort,
  type SocialConnectionRepositoryPort, type SocialPostFilter, type SocialPostRepositoryPort,
} from './social.repository.js';

/** Social posts: one publication per target account, validated against each platform before queueing. */
@Injectable()
export class PostsService {
  constructor(
    @Inject(SOCIAL_POST_REPOSITORY) private readonly posts: SocialPostRepositoryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY) private readonly connections: SocialConnectionRepositoryPort,
    @Inject(CONTENT_REPOSITORY) private readonly contents: ContentRepositoryPort,
    @Inject(SOCIAL_MEDIA_LIBRARY) private readonly media: SocialMediaLibraryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY) private readonly registry: SocialProviderRegistryPort,
    @Inject(PublishingService) private readonly publishing: PublishingService,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  // ───────────── Create / read / edit / delete ─────────────

  async create(actor: Actor, raw: SocialPostInput): Promise<PostResult> {
    const input = normalisePostInput(raw);
    const id = newId();
    const { publications, mediaPending } = await this.plan(actor, input, id);
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

  /** Full replacement of content and targets; a scheduled post keeps its schedule. */
  async update(actor: Actor, id: string, raw: SocialPostInput): Promise<PostResult> {
    const input = normalisePostInput(raw);
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    assertEditable(current);
    const { publications, mediaPending } = await this.plan(actor, input, id);
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
        status: scheduled ? 'scheduled' : targets.length > 0 ? 'ready' : 'draft',
        updatedAt: this.clock.now(),
      };
      await this.posts.updatePost(post);
      await this.posts.replacePublications(actor.churchId, id, targets);
      return { aggregate: { post, publications: targets }, mediaPending };
    });
  }

  async get(churchId: string, id: string): Promise<PostResult> {
    const aggregate = await this.posts.find(churchId, id);
    if (!aggregate) throw notFound('Post');
    const media = await this.loadMedia(churchId, aggregate.post.mediaAssetIds).catch(() => ({ pending: false }));
    return { aggregate, mediaPending: media.pending };
  }

  list(churchId: string, filter: SocialPostFilter, page: PageRequest): Promise<Page<SocialPostAggregate>> {
    return this.posts.list(churchId, filter, page);
  }

  /** Idempotent for posts that are already gone. Never removes anything from a platform. */
  async remove(actor: Actor, id: string): Promise<void> {
    await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) return;
      assertDeletable(aggregate);
      await this.posts.delete(actor.churchId, id);
      await this.audit.record({ churchId: actor.churchId, userId: actor.userId, action: 'post.deleted', socialPostId: id });
    });
  }

  // ───────────── Publish / schedule / retry ─────────────

  /** Queues one independent job per target and returns at once. */
  async publish(actor: Actor, id: string): Promise<SocialPostAggregate> {
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.prePublishCheck(actor.churchId, current, startablePublications(current), { requireMediaReady: true });
    const queued = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const moved: SocialPublication[] = [];
      for (const publication of startablePublications(aggregate)) {
        if (
          await this.posts.transitionPublication(actor.churchId, publication.id, ['pending', 'scheduled'], {
            status: 'queued',
          })
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
    await this.publishing.enqueue(queued);
    await this.publishing.recompute(actor.churchId, id);
    return (await this.posts.find(actor.churchId, id)) as SocialPostAggregate;
  }

  /** Re-scheduling a scheduled post moves it; media may still be rendering at this point. */
  async schedule(actor: Actor, id: string, input: { scheduledAt: Date; timezone?: string }): Promise<SocialPostAggregate> {
    validateScheduleTime(input.scheduledAt, this.clock.now());
    if (input.timezone && !isValidTimeZone(input.timezone)) throw validationError('timezone', 'Unknown time zone');
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.prePublishCheck(actor.churchId, current, startablePublications(current), { requireMediaReady: false });
    const scheduled = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const startable = startablePublications(aggregate);
      for (const publication of startable)
        await this.posts.transitionPublication(actor.churchId, publication.id, ['pending', 'scheduled'], {
          status: 'scheduled',
        });
      const post: SocialPost = {
        ...aggregate.post,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        updatedAt: this.clock.now(),
      };
      const publications = aggregate.publications.map((publication) =>
        startable.includes(publication) ? { ...publication, status: 'scheduled' as const } : publication,
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
      detail: { scheduledAt: input.scheduledAt.toISOString(), timezone: input.timezone ?? null },
    });
    return scheduled;
  }

  async retry(
    actor: Actor,
    id: string,
    options: { publicationIds?: string[]; confirmNotPublished: boolean },
  ): Promise<SocialPostAggregate> {
    const current = await this.posts.find(actor.churchId, id);
    if (!current) throw notFound('Post');
    await this.prePublishCheck(actor.churchId, current, retryablePublications(current, options), {
      requireMediaReady: true,
    });
    const queued = await this.uow.runLocked(postLock(id), async () => {
      const aggregate = await this.posts.find(actor.churchId, id);
      if (!aggregate) throw notFound('Post');
      const moved: SocialPublication[] = [];
      for (const publication of retryablePublications(aggregate, options)) {
        if (
          await this.posts.transitionPublication(actor.churchId, publication.id, ['failed'], {
            status: 'queued',
            outcomeUnknown: false,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            providerRef: undefined,
            pollCount: 0,
          })
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
      detail: { targets: queued.length, confirmedNotPublished: options.confirmNotPublished },
    });
    await this.publishing.enqueue(queued);
    await this.publishing.recompute(actor.churchId, id);
    return (await this.posts.find(actor.churchId, id)) as SocialPostAggregate;
  }

  // ───────────── Validation ─────────────

  /** Shared by create and update: content, media, targets and platform capabilities. */
  private async plan(
    actor: Actor,
    input: SocialPostInput,
    postId: string,
  ): Promise<{ publications: SocialPublication[]; mediaPending: boolean }> {
    if (input.contentId !== undefined && !(await this.contents.findById(actor.churchId, input.contentId)))
      throw validationError('contentId', 'Content not found');
    const media = await this.loadMedia(actor.churchId, input.mediaAssetIds, input.thumbnailAssetId);
    const connections = await this.connections.findByIds(
      actor.churchId,
      input.targets.map((target) => target.connectionId),
    );
    checkTargets(input.targets, connections);
    await checkCapabilities(
      this.registry,
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
        settings: validateTargetSettings(target.platform, target.settings ?? {}),
        providerMetadata: {},
        createdAt: now,
        updatedAt: now,
      })),
    };
  }

  /** Re-checks a post right before it is queued: capabilities and media may have changed. */
  private async prePublishCheck(
    churchId: string,
    aggregate: SocialPostAggregate,
    publications: SocialPublication[],
    options: { requireMediaReady: boolean },
  ): Promise<void> {
    const media = await this.loadMedia(churchId, aggregate.post.mediaAssetIds, aggregate.post.thumbnailAssetId);
    if (options.requireMediaReady && media.pending) throw mediaNotReady();
    const connections = await this.connections.findByIds(
      churchId,
      publications.map((publication) => publication.connectionId),
    );
    checkTargets(publications, connections);
    await checkCapabilities(
      this.registry,
      aggregate.post,
      media.assets,
      publications.map((publication) => publication.platform),
    );
  }

  /** Media must belong to the church, be publishable, and not have failed to render. */
  private async loadMedia(churchId: string, mediaAssetIds: string[], thumbnailAssetId?: string): Promise<MediaCheck> {
    const ids = [...new Set([...mediaAssetIds, ...(thumbnailAssetId ? [thumbnailAssetId] : [])])];
    const found = new Map((await this.media.findAssets(churchId, ids)).map((asset) => [asset.id, asset]));
    const assets = mediaAssetIds.map((id) => {
      const asset = found.get(id);
      if (!asset || !POSTABLE_KINDS.has(asset.kind)) throw invalid('mediaAssetIds', 'Media not found');
      if (asset.status === 'FAILED') throw invalid('mediaAssetIds', 'Some media failed to render; render it again');
      return asset;
    });
    const thumbnail = thumbnailAssetId ? found.get(thumbnailAssetId) : undefined;
    if (thumbnailAssetId && (!thumbnail || !['THUMBNAIL', 'IMAGE'].includes(thumbnail.kind)))
      throw invalid('thumbnailAssetId', 'Thumbnail not found');
    return {
      assets,
      thumbnail,
      pending: [...assets, ...(thumbnail ? [thumbnail] : [])].some((asset) => asset.status === 'PENDING'),
    };
  }
}
