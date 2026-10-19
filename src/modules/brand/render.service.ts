import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  checkpoint, defineJobHandler, type JobContext, JOB_HANDLER_REGISTRY, type JobHandlerRegistry, PermanentJobError, type RunGuard,
} from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { QUEUE, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { USAGE_METER, type UsageMeterPort } from '../../shared/application/ports/usage-meter.port.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import { CONTENT_REPOSITORY, type ContentRepositoryPort } from '../content/content.repository.js';
import { SCRATCH_SPACE, type ScratchSpacePort } from '../sermons/application/ports/out/processing.ports.js';
import {
  BRAND_RENDERER, type BrandRenderingPort, MEDIA_OBSERVER, MEDIA_SETTINGS, type MediaObserverPort, type MediaSettings,
  type RenderedMedia, SERMON_MEDIA, type SermonMediaPort,
} from './adapters/ports.js';
import { MAX_CARD_CHARS } from './adapters/template-svg.js';
import { BrandService } from './brand.service.js';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from './brand.repository.js';
import {
  ASPECTS, BRAND_RENDER_JOB, buildCaptionCues, contentArchived, DEFAULT_RENDER_MESSAGE, extensionFor, generatedAssetKey,
  isRenderSpec, MEDIA_LIST_LIMIT, MEDIA_URL_TTL_SECONDS, type MediaAsset, type MediaAssetKind, type MediaAssetView,
  missingSource, noSourceVideo, planCarousel, RECOVER_RENDERS_EVERY_MS, RECOVER_RENDERS_JOB, type RenderAccepted,
  type RenderJobPayload, type RenderRequest, type RenderSpec, resolveClipWindow, resolveTemplate, type SlidePlan,
  sourceExpired, STALE_RENDER_MESSAGE, STALE_RENDER_MS, STALE_UPLOAD_BATCH, STALE_UPLOAD_MS, THUMBNAIL_AT_MS,
  toCardSpec, toMediaAssetView, truncate, VIDEO_FRAME, VIDEO_RENDER_JOB,
} from './helper.js';

/**
 * Branded media: `POST /content/:id/render` records the assets to produce (PENDING) with an exact
 * render spec and queues the work; the worker renders, stores and marks them READY.
 */
@Injectable()
export class RenderService implements OnModuleInit {
  private readonly logger = new Logger(RenderService.name);

  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly contents: ContentRepositoryPort,
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly assets: MediaAssetRepositoryPort,
    @Inject(BrandService) private readonly brand: BrandService,
    @Inject(SERMON_MEDIA) private readonly sermonMedia: SermonMediaPort,
    @Inject(BRAND_RENDERER) private readonly renderer: BrandRenderingPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(SCRATCH_SPACE) private readonly scratch: ScratchSpacePort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(MEDIA_OBSERVER) private readonly observer: MediaObserverPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(MEDIA_SETTINGS) private readonly settings: MediaSettings,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    for (const job of [BRAND_RENDER_JOB, VIDEO_RENDER_JOB]) {
      this.registry.register(
        defineJobHandler<RenderJobPayload>(job, (payload, context) => this.renderGroup(payload, context)),
      );
    }
    this.registry.register(
      defineJobHandler(RECOVER_RENDERS_JOB, async (_payload, context) => void (await this.recoverStuck(context))),
    );
    this.registry.registerRecurring({
      queue: RECOVER_RENDERS_JOB.queue,
      jobName: RECOVER_RENDERS_JOB.name,
      everyMs: RECOVER_RENDERS_EVERY_MS,
    });
  }

  // ───────────── API side ─────────────

  async requestRender(churchId: string, contentItemId: string, request: RenderRequest): Promise<RenderAccepted> {
    const item = await this.contents.findById(churchId, contentItemId);
    if (!item) throw notFound('Content');
    const content = item.snapshot();
    if (content.status === 'ARCHIVED') throw contentArchived();
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
        objectKey: generatedAssetKey(churchId, content.sermonId, kind, id, extensionFor(contentType)),
        contentType,
        sizeBytes: null,
        width: 'width' in renderSpec ? renderSpec.width : null,
        height: 'height' in renderSpec ? renderSpec.height : null,
        durationMs: null,
        renderGroupId,
        position,
        renderSpec,
        metadata: { templateId: template.id, contentVersion: content.currentVersion },
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
    };

    let assets: MediaAsset[];
    let job: typeof BRAND_RENDER_JOB | typeof VIDEO_RENDER_JOB;
    if (request.format === 'video') {
      const source = await this.sermonMedia.findVideoSource(churchId, content.sermonId);
      if (!source) throw noSourceVideo();
      if (source.removedAt) throw sourceExpired();
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
                heading: request.overrides?.headline || brand.churchName,
                text: truncate(request.overrides?.body || content.body, MAX_CARD_CHARS),
                attribution: content.scripture ?? undefined,
              },
            ];
      assets = slides.map((slide, index) =>
        asset(request.format === 'carousel' ? 'CAROUSEL_SLIDE' : 'IMAGE', 'image/jpeg', index, {
          type: 'card',
          templateId: template.id,
          width,
          height,
          ...slide,
          pageLabel: slides.length > 1 ? `${index + 1} / ${slides.length}` : undefined,
          brand,
        }),
      );
      job = BRAND_RENDER_JOB;
    }

    await this.uow.run(() => this.assets.createMany(assets));
    const payload: RenderJobPayload = { churchId, renderGroupId };
    await this.queue.enqueue(job.queue, job.name, payload, { jobId: `render:${renderGroupId}` });
    return { renderGroupId, assets };
  }

  async listContentMedia(churchId: string, contentItemId: string): Promise<MediaAsset[]> {
    if (!(await this.contents.findById(churchId, contentItemId))) throw notFound('Content');
    return this.assets.listByContent(churchId, contentItemId, MEDIA_LIST_LIMIT);
  }

  async getAsset(churchId: string, id: string): Promise<MediaAsset> {
    const asset = await this.assets.findById(churchId, id);
    if (!asset) throw notFound('Media asset');
    return asset;
  }

  async toView(asset: MediaAsset): Promise<MediaAssetView> {
    const url =
      asset.status === 'READY'
        ? await this.storage.createDownloadUrl(asset.objectKey, MEDIA_URL_TTL_SECONDS)
        : null;
    return toMediaAssetView(asset, url);
  }

  toViews(assets: MediaAsset[]): Promise<MediaAssetView[]> {
    return Promise.all(assets.map((asset) => this.toView(asset)));
  }

  // ───────────── Worker side ─────────────

  /**
   * Safe to run twice: object keys are fixed per asset, a re-upload overwrites, and only assets
   * still PENDING are rendered or marked READY.
   */
  private async renderGroup(payload: RenderJobPayload, context: JobContext): Promise<void> {
    const group = await this.assets.listByRenderGroup(payload.churchId, payload.renderGroupId);
    const pending = group.filter((asset) => asset.status === 'PENDING');
    if (pending.length === 0) return;
    const startedAt = Date.now();
    const kind = pending[0]?.kind ?? 'IMAGE';
    try {
      await this.scratch.withDirectory((workDir) =>
        this.renderPending(payload.churchId, group, pending, workDir, context),
      );
      this.observer.rendered(kind, Date.now() - startedAt, true);
    } catch (error) {
      this.observer.rendered(kind, Date.now() - startedAt, false);
      if (error instanceof PermanentJobError || context.isFinalAttempt) {
        this.logger.warn({ renderGroupId: payload.renderGroupId, err: error }, 'Render failed');
        await this.assets.markFailed(
          payload.churchId,
          pending.map((asset) => asset.id),
          (error instanceof PermanentJobError && error.userMessage) || DEFAULT_RENDER_MESSAGE,
        );
        return;
      }
      throw error; // transient: the queue retries with backoff
    }
  }

  private async renderPending(
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
    const logoPath = logoKey ? await this.download(logoKey, join(workDir, 'logo'), signal, false) : undefined;

    const cards = pending.filter((asset) => specs.get(asset.id)?.type === 'card');
    if (cards.length > 0) {
      const rendered = await this.renderer.renderCarousel({
        workDir,
        name: 'card',
        signal,
        logoPath,
        cards: cards.map((asset) => toCardSpec(specs.get(asset.id) as Extract<RenderSpec, { type: 'card' }>)),
      });
      for (const [index, asset] of cards.entries())
        await this.store(churchId, asset, rendered[index], signal);
    }

    const video = group.find((asset) => specs.get(asset.id)?.type === 'video');
    if (video) {
      const spec = specs.get(video.id) as Extract<RenderSpec, { type: 'video' }>;
      const outputPath =
        video.status === 'PENDING'
          ? await this.renderClip(spec, workDir, logoPath, signal).then(async (rendered) => {
              await this.store(churchId, video, rendered, signal);
              return rendered.filePath;
            })
          : // Retry after the clip was stored: reuse it for the thumbnail instead of re-encoding.
            await this.download(video.objectKey, join(workDir, 'clip.mp4'), signal, true);
      for (const thumbnail of pending.filter((asset) => specs.get(asset.id)?.type === 'thumbnail')) {
        const spec = specs.get(thumbnail.id) as Extract<RenderSpec, { type: 'thumbnail' }>;
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
    const sourcePath = await this.download(spec.sourceObjectKey, join(workDir, 'source'), signal, true);
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

  private async download(key: string, path: string, signal: AbortSignal, required: boolean): Promise<string | undefined> {
    if (!(await this.storage.headObject(key))) {
      if (required) throw missingSource(key);
      return undefined; // a deleted logo just means no watermark
    }
    await this.storage.downloadToFile(key, path, signal);
    return path;
  }

  private async store(churchId: string, asset: MediaAsset, rendered: RenderedMedia | undefined, signal: AbortSignal): Promise<void> {
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

  /** Maintenance: renders whose worker died are failed so the UI stops waiting and can re-render. */
  async recoverStuck(guard?: RunGuard): Promise<number> {
    const now = this.clock.now().getTime();
    const failed = await this.assets.failStaleRenders(new Date(now - STALE_RENDER_MS), STALE_RENDER_MESSAGE);
    await checkpoint(guard);
    // Logo uploads never attached to the profile within a day are removed with their objects.
    for (const asset of await this.assets.findStaleUploads(new Date(now - STALE_UPLOAD_MS), STALE_UPLOAD_BATCH)) {
      await checkpoint(guard);
      await this.assets.delete(asset.churchId, asset.id);
      await this.storage.deleteObject(asset.objectKey);
    }
    return failed;
  }
}
