import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertAIBudget } from '../../../../shared/application/ai-budget.js';
import type { JobContext } from '../../../../shared/application/jobs.js';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  QUEUE,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  GENERATE_REEL_CANDIDATES_JOB,
  type ReelCandidatesJobPayload,
  reelCandidatesJobId,
} from '../../../../shared/application/reel-jobs.js';
import {
  DomainError,
  notFound,
  notReady,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import {
  DEFAULT_CANDIDATE_RULES,
  type ReelCandidate,
  selectReelCandidates,
} from '../../domain/reel-candidates.js';
import { toSentences } from '../../domain/transcript-sentences.js';
import {
  REEL_CANDIDATE_REPOSITORY,
  REEL_OBSERVER,
  REEL_SETTINGS,
  REEL_SOURCE,
  type ReelCandidateRepositoryPort,
  type ReelObserverPort,
  type ReelSermon,
  type ReelSettings,
  type ReelSourcePort,
} from '../ports/out/reel.ports.js';
import { ReelCandidateAIService } from '../services/reel-candidate-ai.service.js';

/** Candidates only make sense for media sermons (documents and pasted text have no video). */
const acceptsCandidates = (sermon: ReelSermon | null): sermon is ReelSermon =>
  sermon !== null && sermon.status === 'READY' && sermon.sourceType === 'MEDIA';

/**
 * Worker: picks 5–10 standalone moments of a READY sermon. Safe to run twice: an automatic run
 * skips sermons that already have candidates, and every run replaces the set in one transaction.
 */
@Injectable()
export class GenerateReelCandidatesUseCase {
  private readonly logger = new Logger(GenerateReelCandidatesUseCase.name);

  constructor(
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_CANDIDATE_REPOSITORY)
    private readonly candidates: ReelCandidateRepositoryPort,
    @Inject(ReelCandidateAIService) private readonly ai: ReelCandidateAIService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(REEL_SETTINGS) private readonly settings: ReelSettings,
    @Inject(REEL_OBSERVER) private readonly observer: ReelObserverPort,
  ) {}

  async execute(
    payload: ReelCandidatesJobPayload,
    context: JobContext,
  ): Promise<void> {
    const { churchId, sermonId } = payload;
    const sermon = await this.source.findSermon(churchId, sermonId);
    if (
      !acceptsCandidates(sermon) ||
      sermon.processingAttempts !== payload.attempt
    ) {
      this.logger.log({ sermonId }, 'Skipping stale Reel candidate job');
      return;
    }
    if (
      !payload.requestId &&
      (await this.candidates.listForSermon(churchId, sermonId)).length > 0
    )
      return;
    const sentences = toSentences(
      await this.source.transcript(churchId, sermonId),
    );
    if (sentences.length === 0) return;
    const proposals = await this.ai.propose({
      churchId,
      sermonId,
      title: sermon.title,
      speaker: sermon.speaker,
      mainTheme: sermon.mainTheme,
      sentences,
      minSeconds: this.settings.minSeconds,
      maxSeconds: this.settings.maxSeconds,
      signal: context.signal,
    });
    const drafts = selectReelCandidates(
      proposals,
      sentences,
      {
        ...DEFAULT_CANDIDATE_RULES,
        minMs: this.settings.minSeconds * 1000,
        maxMs: this.settings.maxSeconds * 1000,
      },
      sermon.durationMs,
    );
    const now = this.clock.now();
    await this.uow.run(() =>
      this.candidates.replaceForSermon(
        churchId,
        sermonId,
        drafts.map((draft): ReelCandidate => ({
          ...draft,
          id: newId(),
          churchId,
          sermonId,
          createdAt: now,
        })),
      ),
    );
    this.observer.candidatesGenerated(drafts.length);
    this.logger.log(
      { churchId, sermonId, candidates: drafts.length },
      'Reel candidates generated',
    );
  }
}

export interface CandidateList {
  items: ReelCandidate[];
  /** Whether Reels can be rendered from this sermon (it has a video that has not expired). */
  renderable: boolean;
}

@Injectable()
export class ListReelCandidatesUseCase {
  constructor(
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(REEL_CANDIDATE_REPOSITORY)
    private readonly candidates: ReelCandidateRepositoryPort,
  ) {}

  async execute(churchId: string, sermonId: string): Promise<CandidateList> {
    if (!(await this.source.findSermon(churchId, sermonId)))
      throw notFound('Sermon');
    const video = await this.source.findVideo(churchId, sermonId);
    return {
      items: await this.candidates.listForSermon(churchId, sermonId),
      renderable: video !== null && video.removedAt === null,
    };
  }
}

/** `POST /sermons/:id/reel-candidates`: re-runs selection in the background. */
@Injectable()
export class RegenerateReelCandidatesUseCase {
  constructor(
    @Inject(REEL_SOURCE) private readonly source: ReelSourcePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async execute(churchId: string, sermonId: string): Promise<void> {
    const sermon = await this.source.findSermon(churchId, sermonId);
    if (!sermon) throw notFound('Sermon');
    if (sermon.status !== 'READY') throw notReady();
    if (!acceptsCandidates(sermon))
      throw new DomainError(
        'UNPROCESSABLE',
        'NO_SOURCE_VIDEO',
        'Reels can only be made from sermons uploaded as audio or video.',
      );
    await assertAIBudget(this.cache, churchId, 'reelCandidates');
    const payload: ReelCandidatesJobPayload = {
      churchId,
      sermonId,
      attempt: sermon.processingAttempts,
      requestId: newId(),
    };
    await this.queue.enqueue(
      GENERATE_REEL_CANDIDATES_JOB.queue,
      GENERATE_REEL_CANDIDATES_JOB.name,
      payload,
      { jobId: reelCandidatesJobId(payload) },
    );
  }
}
