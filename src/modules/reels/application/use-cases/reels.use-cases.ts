import { Inject, Injectable } from '@nestjs/common';
import { assertAIBudget } from '../../../../shared/application/ai-budget.js';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  PLAN_ENTITLEMENTS,
  type PlanEntitlementsPort,
} from '../../../../shared/application/ports/plan-entitlements.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  DomainError,
  notFound,
  notReady,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type {
  Page,
  PageRequest,
} from '../../../../shared/domain/pagination.js';
import {
  applyReelEdit,
  approveReel,
  type Reel,
  type ReelEdit,
  type ReelHook,
  validateWindow,
} from '../../domain/reel.js';
import { toSentences } from '../../domain/transcript-sentences.js';
import {
  REEL_BRAND,
  REEL_CANDIDATE_REPOSITORY,
  REEL_REPOSITORY,
  REEL_SETTINGS,
  REEL_SOURCE,
  type ReelBrandPort,
  type ReelCandidateRepositoryPort,
  type ReelFilter,
  type ReelRepositoryPort,
  type ReelSettings,
  type ReelSourcePort,
} from '../ports/out/reel.ports.js';
import { ReelHookAIService } from '../services/reel-hook-ai.service.js';

export type CreateReelInput =
  | { candidateId: string; title?: string }
  | { sermonId: string; startMs: number; endMs: number; title?: string };

const lockKey = (reelId: string) => `reel:${reelId}`;

/** What the pastor says inside a window: every sentence whose middle falls inside it. */
async function transcriptFor(
  source: ReelSourcePort,
  churchId: string,
  sermonId: string,
  window: { startMs: number; endMs: number },
): Promise<string> {
  return toSentences(await source.transcript(churchId, sermonId))
    .filter((sentence) => {
      const midpoint = (sentence.startMs + sentence.endMs) / 2;
      return midpoint >= window.startMs && midpoint < window.endMs;
    })
    .map((sentence) => sentence.text)
    .join(' ');
}

const defaultTitle = (transcript: string) =>
  transcript
    .split(/\s+/)
    .slice(0, 8)
    .join(' ')
    .replace(/[,;:]$/, '') || 'Sermon moment';

@Injectable()
export class CreateReelUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(REEL_CANDIDATE_REPOSITORY)
    private readonly candidates: ReelCandidateRepositoryPort,
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_BRAND) private readonly brand: ReelBrandPort,
    @Inject(REEL_SETTINGS) private readonly settings: ReelSettings,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string, input: CreateReelInput): Promise<Reel> {
    let sermonId: string;
    let candidateId: string | null = null;
    let window: { startMs: number; endMs: number };
    let transcript: string;
    let title: string | undefined = input.title;
    if ('candidateId' in input) {
      const candidate = await this.candidates.findById(
        churchId,
        input.candidateId,
      );
      if (!candidate) throw notFound('Reel candidate');
      ({ sermonId } = candidate);
      candidateId = candidate.id;
      window = { startMs: candidate.startMs, endMs: candidate.endMs };
      transcript = candidate.transcript;
      title ??= candidate.title;
    } else {
      sermonId = input.sermonId;
      window = { startMs: input.startMs, endMs: input.endMs };
      transcript = '';
    }
    const sermon = await this.source.findSermon(churchId, sermonId);
    if (!sermon) throw notFound('Sermon');
    if (sermon.status !== 'READY') throw notReady();
    if (sermon.sourceType !== 'MEDIA')
      throw new DomainError(
        'UNPROCESSABLE',
        'NO_SOURCE_VIDEO',
        'Reels can only be made from sermons uploaded as video.',
      );
    if (!candidateId) {
      validateWindow(
        window,
        {
          minMs: this.settings.minSeconds * 1000,
          maxMs: this.settings.maxSeconds * 1000,
        },
        sermon.durationMs,
      );
      transcript = await transcriptFor(this.source, churchId, sermonId, window);
    }
    const { videoSettings } = await this.brand.load(churchId);
    const now = this.clock.now();
    const reel: Reel = {
      id: newId(),
      churchId,
      sermonId,
      candidateId,
      title: (
        title?.replace(/\s+/g, ' ').trim() || defaultTitle(transcript)
      ).slice(0, 120),
      ...window,
      transcript,
      hook: null,
      hookOptions: [],
      captionStyle: videoSettings.captionStyle,
      captionPosition: videoSettings.captionPosition,
      status: 'DRAFT',
      progress: 0,
      renderAttempt: 0,
      editedSinceRender: false,
      outputAssetId: null,
      thumbnailAssetId: null,
      durationMs: null,
      sizeBytes: null,
      errorMessage: null,
      approvedAt: null,
      renderRequestedAt: null,
      renderedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.reels.insert(reel);
    return reel;
  }
}

@Injectable()
export class GetReelUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
  ) {}

  async execute(churchId: string, id: string): Promise<Reel> {
    const reel = await this.reels.findById(churchId, id);
    if (!reel) throw notFound('Reel');
    return reel;
  }
}

@Injectable()
export class ListReelsUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
  ) {}

  execute(
    churchId: string,
    filter: ReelFilter,
    page: PageRequest,
  ): Promise<Page<Reel>> {
    return this.reels.list(churchId, filter, page);
  }
}

export interface UpdateReelInput extends Omit<ReelEdit, 'window'> {
  startMs?: number;
  endMs?: number;
}

/** Edits are serialised per Reel; the stored video stays until the next render. */
@Injectable()
export class UpdateReelUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_SETTINGS) private readonly settings: ReelSettings,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    churchId: string,
    id: string,
    input: UpdateReelInput,
  ): Promise<Reel> {
    return this.uow.runLocked(lockKey(id), async () => {
      const reel = await this.reels.findById(churchId, id);
      if (!reel) throw notFound('Reel');
      const { startMs, endMs, ...edit } = input;
      let window: ReelEdit['window'];
      if (startMs !== undefined || endMs !== undefined) {
        const next = {
          startMs: startMs ?? reel.startMs,
          endMs: endMs ?? reel.endMs,
        };
        const sermon = await this.source.findSermon(churchId, reel.sermonId);
        validateWindow(
          next,
          {
            minMs: this.settings.minSeconds * 1000,
            maxMs: this.settings.maxSeconds * 1000,
          },
          sermon?.durationMs ?? null,
        );
        window = {
          ...next,
          transcript: await transcriptFor(
            this.source,
            churchId,
            reel.sermonId,
            next,
          ),
        };
      }
      const updated = applyReelEdit(
        reel,
        { ...edit, window },
        this.clock.now(),
      );
      await this.reels.save(updated);
      return updated;
    });
  }
}

/** `POST /reels/:id/hooks`: AI hook copy only; rendering is a separate, explicit step. */
@Injectable()
export class GenerateReelHooksUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_BRAND) private readonly brand: ReelBrandPort,
    @Inject(PLAN_ENTITLEMENTS)
    private readonly entitlements: PlanEntitlementsPort,
    @Inject(ReelHookAIService) private readonly ai: ReelHookAIService,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string, id: string): Promise<ReelHook[]> {
    const reel = await this.reels.findById(churchId, id);
    if (!reel) throw notFound('Reel');
    if (!(await this.entitlements.allowance(churchId)).reelHooks)
      throw new DomainError(
        'PAYMENT_REQUIRED',
        'PLAN_UPGRADE_REQUIRED',
        'AI hooks are not included in your plan. Upgrade to use them.',
      );
    await assertAIBudget(this.cache, churchId, 'reelHooks');
    const sermon = await this.source.findSermon(churchId, reel.sermonId);
    if (!sermon) throw notFound('Sermon');
    const { voice, videoSettings } = await this.brand.load(churchId);
    const hooks = await this.ai.generate({
      churchId,
      sermonId: reel.sermonId,
      excerpt: reel.transcript,
      sermonTitle: sermon.title,
      speaker: sermon.speaker,
      mainTheme: sermon.mainTheme,
      summary: sermon.summary,
      preferredStyle: videoSettings.hookStyle,
      voice,
    });
    if (hooks.length === 0)
      throw new DomainError(
        'UNAVAILABLE',
        'AI_UNAVAILABLE',
        'We could not write hooks for this Reel. Please try again.',
      );
    // Suggestions are kept for the UI; the Reel's chosen hook (and its video) are unchanged.
    await this.uow.runLocked(lockKey(id), async () => {
      const fresh = await this.reels.findById(churchId, id);
      if (fresh)
        await this.reels.save({
          ...fresh,
          hookOptions: hooks,
          updatedAt: this.clock.now(),
        });
    });
    return hooks;
  }
}

@Injectable()
export class ApproveReelUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Idempotent: approving an approved Reel changes nothing. */
  async execute(churchId: string, id: string): Promise<Reel> {
    return this.uow.runLocked(lockKey(id), async () => {
      const reel = await this.reels.findById(churchId, id);
      if (!reel) throw notFound('Reel');
      const approved = approveReel(reel, this.clock.now());
      if (approved !== reel) await this.reels.save(approved);
      return approved;
    });
  }
}

@Injectable()
export class DeleteReelUseCase {
  constructor(
    @Inject(REEL_REPOSITORY) private readonly reels: ReelRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  /**
   * Idempotent. Rendered media assets are kept: a scheduled post may still carry them. A render
   * in flight notices the deletion and removes its own output.
   */
  async execute(churchId: string, id: string): Promise<void> {
    await this.uow.runLocked(lockKey(id), () =>
      this.reels.delete(churchId, id),
    );
  }
}
