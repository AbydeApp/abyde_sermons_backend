import { Inject, Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import {
  checkpoint,
  type JobContext,
  PermanentJobError,
  type RunGuard,
} from '../../../../shared/application/jobs.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  PLAN_ENTITLEMENTS,
  type PlanEntitlementsPort,
} from '../../../../shared/application/ports/plan-entitlements.port.js';
import {
  QUEUE,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
import {
  STORAGE,
  type StoragePort,
} from '../../../../shared/application/ports/storage.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  USAGE_METER,
  type UsageMeterPort,
} from '../../../../shared/application/ports/usage-meter.port.js';
import {
  DomainError,
  notFound,
} from '../../../../shared/domain/domain-error.js';
import { buildCaptionCues } from '../../../brand/domain/captions.js';
import { isAnimatedCaptionStyle } from '../../../brand/domain/video-settings.js';
import {
  SCRATCH_SPACE,
  type ScratchSpacePort,
} from '../../../sermons/application/ports/out/processing.ports.js';
import { type CropPlan, planCropPath } from '../../domain/crop-path.js';
import {
  isRendering,
  needsRender,
  queueRender,
  type Reel,
  type ReelRenderStage,
  STAGE_PROGRESS,
} from '../../domain/reel.js';
import {
  REEL_BRAND,
  REEL_MEDIA,
  REEL_OBSERVER,
  REEL_RENDERER,
  REEL_REPOSITORY,
  REEL_SETTINGS,
  REEL_SOURCE,
  type ReelBrandPort,
  type ReelMediaPort,
  type ReelObserverPort,
  type ReelRendererPort,
  type ReelRepositoryPort,
  type ReelSettings,
  type ReelSourcePort,
  SPEAKER_TRACKER,
  type SpeakerTrackingPort,
} from '../ports/out/reel.ports.js';
import {
  RENDER_REEL_JOB,
  type ReelRenderJobPayload,
  reelRenderJobId,
} from '../reel-jobs.js';

export const REEL_FRAME = { width: 1080, height: 1920 } as const;
/** Sources narrower than this (portrait or close to it) are fitted, not cropped. */
const VERTICAL_ASPECT = 9 / 16 + 0.01;
const STALE_RENDER_MS = 60 * 60 * 1000;
const PRIORITY_RENDER = 1;

const plan = (code: string, message: string) =>
  new DomainError('PAYMENT_REQUIRED', code, message);

/**
 * `POST /reels/:id/render`. Naturally idempotent: a Reel that is rendering or already rendered
 * (and unchanged) is returned as is, so a double click never renders or charges twice.
 */
@Injectable()
export class RequestReelRenderUseCase {
  private readonly logger = new Logger(RequestReelRenderUseCase.name);

  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(PLAN_ENTITLEMENTS)
    private readonly entitlements: PlanEntitlementsPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string, id: string): Promise<Reel> {
    const current = await this.reels.findById(churchId, id);
    if (!current) throw notFound('Reel');
    if (!needsRender(current)) return current;
    const video = await this.source.findVideo(churchId, current.sermonId);
    if (!video)
      throw new DomainError(
        'UNPROCESSABLE',
        'NO_SOURCE_VIDEO',
        'Reels can only be rendered from sermons uploaded as video.',
      );
    if (video.removedAt)
      throw new DomainError(
        'UNPROCESSABLE',
        'SOURCE_EXPIRED',
        'The original sermon video has been removed under your plan’s retention period, so new Reels cannot be rendered from it.',
      );

    // Plan check, in-flight count and the QUEUED write are serialised per church, so two requests
    // can never both take the last Reel of the period.
    const decision = await this.uow.runLocked(
      `reel:quota:${churchId}`,
      async () => {
        const reel = await this.reels.findById(churchId, id);
        if (!reel) throw notFound('Reel');
        if (!needsRender(reel))
          return { reel, priority: undefined, queued: false };
        const allowance = await this.entitlements.allowance(churchId);
        if (allowance.reelsPerPeriod === 0)
          throw plan(
            'PLAN_UPGRADE_REQUIRED',
            'Reel rendering is not included in your plan. Upgrade to render Reels.',
          );
        if (
          isAnimatedCaptionStyle(reel.captionStyle) &&
          !allowance.animatedCaptions
        )
          throw plan(
            'PLAN_UPGRADE_REQUIRED',
            'Animated captions are not included in your plan. Choose the Clean caption style or upgrade.',
          );
        if (reel.hook && !allowance.reelHooks)
          throw plan(
            'PLAN_UPGRADE_REQUIRED',
            'Hooks are not included in your plan. Remove the hook or upgrade.',
          );
        const inFlight = await this.reels.countRendering(churchId);
        if (allowance.reelsUsed + inFlight >= allowance.reelsPerPeriod)
          throw plan(
            'REEL_LIMIT_REACHED',
            `You've used all ${allowance.reelsPerPeriod} Reels in your plan for this period.`,
          );
        const queued = queueRender(reel, this.clock.now());
        await this.reels.save(queued);
        return {
          reel: queued,
          priority: allowance.priorityProcessing ? PRIORITY_RENDER : undefined,
          queued: true,
        };
      },
    );
    if (!decision.queued) return decision.reel;

    const payload: ReelRenderJobPayload = {
      churchId,
      reelId: id,
      renderAttempt: decision.reel.renderAttempt,
    };
    try {
      await this.queue.enqueue(
        RENDER_REEL_JOB.queue,
        RENDER_REEL_JOB.name,
        payload,
        {
          jobId: reelRenderJobId(payload),
          priority: decision.priority,
        },
      );
    } catch (error) {
      // The QUEUED state is committed; fail visibly (and free the slot) instead of hanging.
      this.logger.error(
        { err: error, reelId: id },
        'Failed to enqueue Reel render',
      );
      const message =
        'We could not start rendering this Reel. Please try again.';
      await this.reels.failRender(churchId, id, payload.renderAttempt, message);
      return {
        ...decision.reel,
        status: 'FAILED',
        progress: 0,
        errorMessage: message,
      };
    }
    return decision.reel;
  }
}

/** The stored Reel no longer belongs to this job (deleted, re-queued or finished elsewhere). */
class ReelSupersededError extends Error {
  constructor(reelId: string) {
    super(`Reel ${reelId} changed while it was rendering`);
    this.name = 'ReelSupersededError';
  }
}

/**
 * Worker side of a render. Safe to run twice: every state change is conditional on the render
 * attempt, output objects and asset rows are keyed by (Reel, attempt), and usage is metered with
 * dedupe keys.
 */
@Injectable()
export class RenderReelUseCase {
  private readonly logger = new Logger(RenderReelUseCase.name);

  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_BRAND) private readonly brand: ReelBrandPort,
    @Inject(REEL_RENDERER) private readonly renderer: ReelRendererPort,
    @Inject(SPEAKER_TRACKER) private readonly tracker: SpeakerTrackingPort,
    @Inject(REEL_MEDIA) private readonly media: ReelMediaPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(SCRATCH_SPACE) private readonly scratch: ScratchSpacePort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(REEL_OBSERVER) private readonly observer: ReelObserverPort,
    @Inject(REEL_SETTINGS) private readonly settings: ReelSettings,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    payload: ReelRenderJobPayload,
    context: JobContext,
  ): Promise<void> {
    const reel = await this.reels.findById(payload.churchId, payload.reelId);
    if (
      !reel ||
      reel.renderAttempt !== payload.renderAttempt ||
      !isRendering(reel.status)
    ) {
      this.logger.log(
        { reelId: payload.reelId, renderAttempt: payload.renderAttempt },
        'Skipping stale Reel render',
      );
      return;
    }
    const log = {
      churchId: reel.churchId,
      sermonId: reel.sermonId,
      reelId: reel.id,
      jobId: context.jobId,
    };
    const startedAt = Date.now();
    try {
      await this.scratch.withDirectory((dir) =>
        this.render(reel, dir, context),
      );
      const elapsedMs = Date.now() - startedAt;
      this.observer.rendered(elapsedMs, true);
      await this.usage.record({
        churchId: reel.churchId,
        unit: 'RENDER_SECOND',
        quantity: Math.max(1, Math.ceil(elapsedMs / 1000)),
        sermonId: reel.sermonId,
        dedupeKey: `reel-render-seconds:${reel.id}:${reel.renderAttempt}`,
      });
      this.logger.log({ ...log, elapsedMs }, 'Reel rendered');
    } catch (error) {
      if (error instanceof ReelSupersededError) {
        this.logger.log(log, 'Reel render superseded; stopping');
        return;
      }
      this.observer.rendered(Date.now() - startedAt, false);
      const permanent = error instanceof PermanentJobError;
      if (permanent || context.isFinalAttempt) {
        this.logger.warn({ ...log, err: error }, 'Reel render failed');
        await this.reels.failRender(
          reel.churchId,
          reel.id,
          reel.renderAttempt,
          (permanent && error.userMessage) ||
            'We could not render this Reel. Please try again.',
        );
        return;
      }
      throw error; // transient: the queue retries with backoff
    }
  }

  private async render(
    reel: Reel,
    dir: string,
    context: JobContext,
  ): Promise<void> {
    const { churchId } = reel;
    const signal = context.signal;
    const advance = async (stage: ReelRenderStage) => {
      if (
        !(await this.reels.advanceRender(
          churchId,
          reel.id,
          reel.renderAttempt,
          stage,
          STAGE_PROGRESS[stage],
        ))
      )
        throw new ReelSupersededError(reel.id);
    };

    await advance('PREPARING');
    const video = await this.source.findVideo(churchId, reel.sermonId);
    const unavailable = new PermanentJobError(
      `Source video for Reel ${reel.id} is unavailable`,
      'The original sermon video is no longer available.',
    );
    if (!video || video.removedAt) throw unavailable;
    if (!(await this.storage.headObject(video.objectKey))) throw unavailable;
    const sourcePath = join(dir, 'source');
    await this.storage.downloadToFile(video.objectKey, sourcePath, signal);
    const probed = await this.renderer.probe(sourcePath, signal);
    if (reel.endMs > probed.durationMs + 1_000)
      throw new PermanentJobError(
        `Reel ${reel.id} ends after the source video`,
        'This moment is outside the sermon video.',
      );
    const [brand, sermon, transcript] = [
      await this.brand.load(churchId),
      await this.source.findSermon(churchId, reel.sermonId),
      await this.source.transcript(churchId, reel.sermonId),
    ];
    const settings = brand.videoSettings;

    await advance('CROPPING');
    const clipMs = reel.endMs - reel.startMs;
    let crop: CropPlan | null = null;
    if (probed.width / probed.height > VERTICAL_ASPECT) {
      const tracking = await this.tracker.analyze({
        videoPath: sourcePath,
        startMs: reel.startMs,
        endMs: reel.endMs,
        width: probed.width,
        height: probed.height,
        signal,
      });
      crop = planCropPath({
        samples: tracking.samples,
        sourceWidth: probed.width,
        sourceHeight: probed.height,
        durationMs: clipMs,
      });
    }
    await checkpoint(context);

    const logoKey = brand.snapshot.logoObjectKey;
    let logoPath: string | undefined;
    if (logoKey && (await this.storage.headObject(logoKey))) {
      logoPath = join(dir, 'logo');
      await this.storage.downloadToFile(logoKey, logoPath, signal);
    }
    const rendered = await this.renderer.render({
      workDir: dir,
      sourcePath,
      source: probed,
      startMs: reel.startMs,
      endMs: reel.endMs,
      ...REEL_FRAME,
      crop,
      hook: reel.hook
        ? {
            ...reel.hook,
            durationMs: Math.min(this.settings.hookSeconds * 1000, clipMs),
          }
        : null,
      captions: {
        style: reel.captionStyle,
        position: reel.captionPosition,
        cues: buildCaptionCues(transcript, reel.startMs, reel.endMs),
      },
      labels: {
        speaker: settings.showSpeakerName ? sermon?.speaker : undefined,
        church: settings.showChurchName ? brand.snapshot.churchName : undefined,
      },
      brand: brand.snapshot,
      logoPath,
      logoPosition: settings.logoPosition,
      outro: settings.outroEnabled
        ? {
            durationMs: this.settings.outroSeconds * 1000,
            churchName: brand.snapshot.churchName,
            handle: brand.snapshot.socialHandle,
            website: brand.snapshot.website,
          }
        : null,
      onStage: advance,
      signal,
    });
    await checkpoint(context);

    const stored = await this.media.store({
      churchId,
      sermonId: reel.sermonId,
      reelId: reel.id,
      renderAttempt: reel.renderAttempt,
      rendered,
      signal,
    });
    const completed = await this.reels.completeRender(
      churchId,
      reel.id,
      reel.renderAttempt,
      {
        outputAssetId: stored.videoAssetId,
        thumbnailAssetId: stored.thumbnailAssetId,
        durationMs: rendered.durationMs,
        sizeBytes: stored.videoSizeBytes,
        renderedAt: this.clock.now(),
      },
    );
    if (!completed) {
      // Deleted or re-queued while encoding: nothing points at this output.
      await this.media.discard(churchId, [
        stored.videoAssetId,
        stored.thumbnailAssetId,
      ]);
      throw new ReelSupersededError(reel.id);
    }
    const meter = (
      unit: 'REEL_RENDERED' | 'STORAGE_BYTES',
      quantity: number,
      key: string,
    ) =>
      this.usage.record({
        churchId,
        unit,
        quantity,
        sermonId: reel.sermonId,
        dedupeKey: key,
      });
    await meter(
      'REEL_RENDERED',
      1,
      `reel-render:${reel.id}:${reel.renderAttempt}`,
    );
    await meter(
      'STORAGE_BYTES',
      stored.videoSizeBytes,
      `media-asset:${stored.videoAssetId}`,
    );
    await meter(
      'STORAGE_BYTES',
      stored.thumbnailSizeBytes,
      `media-asset:${stored.thumbnailAssetId}`,
    );
  }
}

/** Maintenance: renders whose worker died are failed so the UI stops waiting and the slot frees up. */
@Injectable()
export class RecoverStuckReelsUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    await checkpoint(guard);
    return this.reels.failStaleRenders(
      new Date(this.clock.now().getTime() - STALE_RENDER_MS),
      'Rendering took too long. Please try again.',
    );
  }
}
