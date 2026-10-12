import { Inject, Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { type JobContext, PermanentJobError, type RunGuard, checkpoint } from '../../../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { QUEUE, QUEUES, type QueuePort } from '../../../../shared/application/ports/queue.port.js';
import { STORAGE, type StoragePort } from '../../../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../../shared/application/ports/unit-of-work.port.js';
import { USAGE_METER, type UsageMeterPort } from '../../../../shared/application/ports/usage-meter.port.js';
import { DomainError, notFound} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { CONTENT_REPOSITORY, type ContentRepositoryPort } from '../../../content/application/ports/out/content-repository.port.js';
import { SCRATCH_SPACE, type ScratchSpacePort } from '../../../sermons/application/ports/out/processing.ports.js';
import { buildCaptionCues } from '../../domain/captions.js';
import { planCarousel, type SlidePlan } from '../../domain/carousel-planner.js';
import { resolveClipWindow } from '../../domain/clip-window.js';
import { generatedAssetKey, type MediaAsset, type MediaAssetKind } from '../../domain/media-asset.js';
import { isRenderSpec, type RenderSpec } from '../../domain/render-spec.js';
import { ASPECTS, type Aspect, findTemplate, type RenderFormat, resolveTemplate, VIDEO_FRAME } from '../../domain/templates.js';
import { type CardSpec, MAX_CARD_CHARS } from '../../domain/template-svg.js';
import {
  BRAND_RENDERER,
  type BrandRenderingPort,
  MEDIA_ASSET_REPOSITORY,
  MEDIA_OBSERVER,
  MEDIA_SETTINGS,
  type MediaAssetRepositoryPort,
  type MediaObserverPort,
  type MediaSettings,
  type RenderedMedia,
} from '../ports/out/brand.ports.js';
import { SERMON_MEDIA, type SermonMediaPort } from '../ports/out/sermon-media.port.js';
import { BrandProfileService } from './brand-profile.use-cases.js';

export interface RenderJobPayload {
  churchId: string;
  renderGroupId: string;
}

export const BRAND_RENDER_JOB = {
  queue: QUEUES.BRAND_RENDER,
  name: 'render-images',
} as const;
export const VIDEO_RENDER_JOB = {
  queue: QUEUES.VIDEO_RENDER,
  name: 'render-clip',
} as const;
export const RECOVER_RENDERS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'recover-stuck-renders',
} as const;

const STALE_RENDER_MS = 60 * 60 * 1000;
const THUMBNAIL_AT_MS = 1_000;

export interface RenderRequest {
  format: RenderFormat;
  templateId?: string;
  aspect?: Aspect;
  /** Video only: overrides the passage the content was generated from. */
  clip?: { startMs: number; endMs: number };
}

export interface RenderAccepted {
  renderGroupId: string;
  assets: MediaAsset[];
}

const extensionFor = (contentType: string) =>
  contentType === 'video/mp4'
    ? 'mp4'
    : contentType === 'image/jpeg'
      ? 'jpg'
      : 'png';

/**
 * `POST /content/:id/render`: records the assets to produce (PENDING) with an exact render spec,
 * then queues the work. Nothing is rendered in the API process.
 */
@Injectable()
export class RequestContentRenderUseCase {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
    @Inject(SERMON_MEDIA) private readonly sermonMedia: SermonMediaPort,
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(MEDIA_SETTINGS) private readonly settings: MediaSettings,
  ) {}

  async execute(
    churchId: string,
    contentItemId: string,
    request: RenderRequest,
  ): Promise<RenderAccepted> {
    const item = await this.contents.findById(churchId, contentItemId);
    if (!item) throw notFound('Content');
    const content = item.snapshot();
    if (content.status === 'ARCHIVED')
      throw new DomainError(
        'UNPROCESSABLE',
        'CONTENT_ARCHIVED',
        'Archived content cannot be rendered.',
      );
    const profile = await this.brand.load(churchId);
    const brand = await this.brand.snapshot(profile);
    const template = resolveTemplate({
      format: request.format,
      contentType: content.type,
      requested: request.templateId,
      churchDefaults: profile.templateDefaults,
    });
    const renderGroupId = newId();
    const now = this.clock.now();
    const asset = (
      kind: Exclude<MediaAssetKind, 'BRAND_LOGO'>,
      contentType: string,
      position: number,
      renderSpec: RenderSpec,
    ): MediaAsset => {
      const id = newId();
      return {
        id,
        churchId,
        sermonId: content.sermonId,
        contentItemId,
        kind,
        status: 'PENDING',
        objectKey: generatedAssetKey(
          churchId,
          content.sermonId,
          kind,
          id,
          extensionFor(contentType),
        ),
        contentType,
        sizeBytes: null,
        width: 'width' in renderSpec ? renderSpec.width : null,
        height: 'height' in renderSpec ? renderSpec.height : null,
        durationMs: null,
        renderGroupId,
        position,
        renderSpec,
        metadata: {
          templateId: template.id,
          contentVersion: content.currentVersion,
        },
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
    };

    let assets: MediaAsset[];
    let job: typeof BRAND_RENDER_JOB | typeof VIDEO_RENDER_JOB;
    if (request.format === 'video') {
      const source = await this.sermonMedia.findVideoSource(
        churchId,
        content.sermonId,
      );
      if (!source)
        throw new DomainError(
          'UNPROCESSABLE',
          'NO_SOURCE_VIDEO',
          'Clips can only be made from sermons uploaded as video.',
        );
      if (source.removedAt)
        throw new DomainError(
          'UNPROCESSABLE',
          'SOURCE_EXPIRED',
          'The original sermon video has been removed under your plan’s retention period, so new clips cannot be cut from it.',
        );
      const window = resolveClipWindow({
        requested: request.clip,
        source: content.sourceMetadata,
        sermonDurationMs: source.durationMs,
        maxClipMs: this.settings.maxClipSeconds * 1000,
      });
      const captions = buildCaptionCues(
        await this.sermonMedia.transcriptTimings(churchId, content.sermonId),
        window.startMs,
        window.endMs,
      );
      const video = asset('VIDEO', 'video/mp4', 0, {
        type: 'video',
        templateId: template.id,
        sourceObjectKey: source.objectKey,
        startMs: window.startMs,
        endMs: window.endMs,
        width: VIDEO_FRAME.width,
        height: VIDEO_FRAME.height,
        captions,
        brand,
      });
      assets = [
        video,
        asset('THUMBNAIL', 'image/jpeg', 1, {
          type: 'thumbnail',
          videoAssetId: video.id,
          atMs: Math.min(THUMBNAIL_AT_MS, window.endMs - window.startMs - 1),
        }),
      ];
      job = VIDEO_RENDER_JOB;
    } else {
      const { width, height } = ASPECTS[request.aspect ?? 'square'];
      const slides: SlidePlan[] =
        request.format === 'carousel'
          ? planCarousel({
              title: content.title,
              body: content.body,
              scripture: content.scripture,
              churchName: brand.churchName,
              callToAction: profile.voice.ctaStyle,
            })
          : [
              {
                heading: brand.churchName,
                text: truncate(content.body, MAX_CARD_CHARS),
                attribution: content.scripture ?? undefined,
              },
            ];
      assets = slides.map((slide, index) =>
        asset(
          request.format === 'carousel' ? 'CAROUSEL_SLIDE' : 'IMAGE',
          'image/jpeg',
          index,
          {
            type: 'card',
            templateId: template.id,
            width,
            height,
            ...slide,
            pageLabel:
              slides.length > 1 ? `${index + 1} / ${slides.length}` : undefined,
            brand,
          },
        ),
      );
      job = BRAND_RENDER_JOB;
    }

    await this.uow.run(() => this.assets.createMany(assets));
    const payload: RenderJobPayload = { churchId, renderGroupId };
    await this.queue.enqueue(job.queue, job.name, payload, {
      jobId: `render:${renderGroupId}`,
    });
    return { renderGroupId, assets };
  }
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * Worker side of a render. Safe to run twice: object keys are fixed per asset, a re-upload
 * overwrites, and only assets still PENDING are rendered or marked READY.
 */
@Injectable()
export class RenderMediaGroupUseCase {
  private readonly logger = new Logger(RenderMediaGroupUseCase.name);

  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(BRAND_RENDERER) private readonly renderer: BrandRenderingPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(SCRATCH_SPACE) private readonly scratch: ScratchSpacePort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(MEDIA_OBSERVER) private readonly observer: MediaObserverPort,
  ) {}

  async execute(payload: RenderJobPayload, context: JobContext): Promise<void> {
    const group = await this.assets.listByRenderGroup(
      payload.churchId,
      payload.renderGroupId,
    );
    const pending = group.filter((asset) => asset.status === 'PENDING');
    if (pending.length === 0) return;
    const startedAt = Date.now();
    const kind = pending[0]?.kind ?? 'IMAGE';
    try {
      await this.scratch.withDirectory((workDir) =>
        this.renderGroup(payload.churchId, group, pending, workDir, context),
      );
      this.observer.rendered(kind, Date.now() - startedAt, true);
    } catch (error) {
      this.observer.rendered(kind, Date.now() - startedAt, false);
      if (error instanceof PermanentJobError || context.isFinalAttempt) {
        this.logger.warn(
          { renderGroupId: payload.renderGroupId, err: error },
          'Render failed',
        );
        await this.assets.markFailed(
          payload.churchId,
          pending.map((asset) => asset.id),
          (error instanceof PermanentJobError && error.userMessage) ||
            'We could not render this media. Please try again.',
        );
        return;
      }
      throw error; // transient: the queue retries with backoff
    }
  }

  private async renderGroup(
    churchId: string,
    group: MediaAsset[],
    pending: MediaAsset[],
    workDir: string,
    context: JobContext,
  ): Promise<void> {
    const specs = new Map<string, RenderSpec>();
    for (const asset of group) {
      if (!isRenderSpec(asset.renderSpec))
        throw new PermanentJobError(`Asset ${asset.id} has no render spec`);
      specs.set(asset.id, asset.renderSpec);
    }
    const signal = context.signal;
    const logoKey = [...specs.values()]
      .map((spec) => ('brand' in spec ? spec.brand.logoObjectKey : undefined))
      .find(Boolean);
    const logoPath = logoKey
      ? await this.download(logoKey, join(workDir, 'logo'), signal, false)
      : undefined;

    const cards = pending.filter(
      (asset) => specs.get(asset.id)?.type === 'card',
    );
    if (cards.length > 0) {
      const rendered = await this.renderer.renderCarousel({
        workDir,
        name: 'card',
        signal,
        logoPath,
        cards: cards.map((asset) =>
          toCardSpec(
            specs.get(asset.id) as Extract<RenderSpec, { type: 'card' }>,
          ),
        ),
      });
      for (const [index, asset] of cards.entries())
        await this.store(churchId, asset, rendered[index], signal);
    }

    const video = group.find((asset) => specs.get(asset.id)?.type === 'video');
    if (video) {
      const spec = specs.get(video.id) as Extract<
        RenderSpec,
        { type: 'video' }
      >;
      const outputPath =
        video.status === 'PENDING'
          ? await this.renderClip(spec, workDir, logoPath, signal).then(
              async (rendered) => {
                await this.store(churchId, video, rendered, signal);
                return rendered.filePath;
              },
            )
          : // Retry after the clip was stored: reuse it for the thumbnail instead of re-encoding.
            await this.download(
              video.objectKey,
              join(workDir, 'clip.mp4'),
              signal,
              true,
            );
      for (const thumbnail of pending.filter(
        (asset) => specs.get(asset.id)?.type === 'thumbnail',
      )) {
        const spec = specs.get(thumbnail.id) as Extract<
          RenderSpec,
          { type: 'thumbnail' }
        >;
        await checkpoint(context);
        const rendered = await this.renderer.renderThumbnail({
          workDir,
          name: `thumb-${thumbnail.position}`,
          signal,
          videoPath: outputPath as string,
          atMs: spec.atMs,
        });
        await this.store(churchId, thumbnail, rendered, signal);
      }
    }
  }

  private async renderClip(
    spec: Extract<RenderSpec, { type: 'video' }>,
    workDir: string,
    logoPath: string | undefined,
    signal: AbortSignal,
  ): Promise<RenderedMedia> {
    const sourcePath = await this.download(
      spec.sourceObjectKey,
      join(workDir, 'source'),
      signal,
      true,
    );
    return this.renderer.renderVideo({
      workDir,
      name: 'clip',
      signal,
      sourcePath: sourcePath as string,
      startMs: spec.startMs,
      endMs: spec.endMs,
      width: spec.width,
      height: spec.height,
      captions: spec.captions,
      brand: spec.brand,
      logoPath,
    });
  }

  private async download(
    key: string,
    path: string,
    signal: AbortSignal,
    required: boolean,
  ): Promise<string | undefined> {
    if (!(await this.storage.headObject(key))) {
      if (required)
        throw new PermanentJobError(
          `Source object ${key} is missing`,
          'The original media for this render is no longer available.',
        );
      return undefined; // a deleted logo just means no watermark
    }
    await this.storage.downloadToFile(key, path, signal);
    return path;
  }

  private async store(
    churchId: string,
    asset: MediaAsset,
    rendered: RenderedMedia | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (!rendered) throw new Error(`Renderer returned nothing for ${asset.id}`);
    const stored = await this.storage.putObject({
      key: asset.objectKey,
      contentType: rendered.contentType,
      filePath: rendered.filePath,
      signal,
    });
    const marked = await this.assets.markReady(churchId, asset.id, {
      sizeBytes: stored.sizeBytes,
      width: rendered.width,
      height: rendered.height,
      durationMs: rendered.durationMs ?? null,
    });
    if (!marked) {
      // Deleted while rendering: do not leave an orphaned object behind.
      await this.storage.deleteObject(asset.objectKey);
      return;
    }
    await this.usage.record({
      churchId,
      unit: 'STORAGE_BYTES',
      quantity: stored.sizeBytes,
      sermonId: asset.sermonId ?? undefined,
      dedupeKey: `media-asset:${asset.id}`,
    });
  }
}

function toCardSpec(spec: Extract<RenderSpec, { type: 'card' }>): CardSpec {
  const template = findTemplate(spec.templateId);
  if (!template)
    throw new PermanentJobError(`Unknown template ${spec.templateId}`);
  return {
    template,
    width: spec.width,
    height: spec.height,
    heading: spec.heading,
    text: spec.text,
    attribution: spec.attribution,
    pageLabel: spec.pageLabel,
    brand: spec.brand,
  };
}

/** Maintenance: renders whose worker died are failed so the UI stops waiting and can re-render. */
@Injectable()
export class RecoverStuckRendersUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    const now = this.clock.now().getTime();
    const failed = await this.assets.failStaleRenders(
      new Date(now - STALE_RENDER_MS),
      'Rendering took too long. Please try again.',
    );
    await checkpoint(guard);
    // Logo uploads never attached to the profile within a day are removed with their objects.
    for (const asset of await this.assets.findStaleUploads(
      new Date(now - 24 * STALE_RENDER_MS),
      200,
    )) {
      await checkpoint(guard);
      await this.assets.delete(asset.churchId, asset.id);
      await this.storage.deleteObject(asset.objectKey);
    }
    return failed;
  }
}

@Injectable()
export class ListContentMediaUseCase {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
  ) {}

  async execute(
    churchId: string,
    contentItemId: string,
  ): Promise<MediaAsset[]> {
    if (!(await this.contents.findById(churchId, contentItemId)))
      throw notFound('Content');
    return this.assets.listByContent(churchId, contentItemId, 100);
  }
}

@Injectable()
export class GetMediaAssetUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
  ) {}

  async execute(churchId: string, id: string): Promise<MediaAsset> {
    const asset = await this.assets.findById(churchId, id);
    if (!asset) throw notFound('Media asset');
    return asset;
  }
}
