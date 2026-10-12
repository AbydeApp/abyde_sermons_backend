import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CompletedRender,
  ProbedVideo,
  ReelCandidateRepositoryPort,
  ReelFilter,
  ReelRendererPort,
  ReelRepositoryPort,
  RenderedReel,
  RenderReelInput,
  SpeakerTrackingPort,
  TrackingResult,
} from '../../src/modules/reels/application/ports/out/reel.ports.js';
import type { ReelCandidate } from '../../src/modules/reels/domain/reel-candidates.js';
import {
  isRendering,
  type Reel,
  type ReelRenderStage,
} from '../../src/modules/reels/domain/reel.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../src/shared/domain/pagination.js';
import type { InMemoryDb, TestClock } from './in-memory-db.js';

const clone = <T>(value: T): T => structuredClone(value);
const values = <T>(map: Map<string, T>): T[] => [...map.values()];

export class InMemoryReelRepository implements ReelRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  private own(churchId: string, id: string): Reel | undefined {
    const row = this.db.reels.get(id);
    return row && row.churchId === churchId ? row : undefined;
  }

  async insert(reel: Reel) {
    this.db.reels.set(reel.id, clone(reel));
  }

  async findById(churchId: string, id: string) {
    const row = this.own(churchId, id);
    return row ? clone(row) : null;
  }

  async list(
    churchId: string,
    filter: ReelFilter,
    page: PageRequest,
  ): Promise<Page<Reel>> {
    const rows = values(this.db.reels)
      .filter(
        (reel) =>
          reel.churchId === churchId &&
          (!filter.sermonId || reel.sermonId === filter.sermonId) &&
          (!filter.status || reel.status === filter.status),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    return {
      items: rows
        .slice(skipFor(page), skipFor(page) + page.pageSize)
        .map(clone),
      total: rows.length,
      ...page,
    };
  }

  async save(reel: Reel) {
    if (this.own(reel.churchId, reel.id))
      this.db.reels.set(
        reel.id,
        clone({ ...reel, updatedAt: this.clock.now() }),
      );
  }

  async countRendering(churchId: string) {
    return values(this.db.reels).filter(
      (reel) => reel.churchId === churchId && isRendering(reel.status),
    ).length;
  }

  private transition(
    churchId: string,
    id: string,
    renderAttempt: number,
    changes: Partial<Reel>,
  ): boolean {
    const row = this.own(churchId, id);
    if (!row || row.renderAttempt !== renderAttempt || !isRendering(row.status))
      return false;
    Object.assign(row, changes, { updatedAt: this.clock.now() });
    return true;
  }

  async advanceRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    stage: ReelRenderStage,
    progress: number,
  ) {
    return this.transition(churchId, id, renderAttempt, {
      status: stage,
      progress,
    });
  }

  async completeRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    result: CompletedRender,
  ) {
    return this.transition(churchId, id, renderAttempt, {
      status: 'COMPLETED',
      progress: 100,
      editedSinceRender: false,
      errorMessage: null,
      ...result,
    });
  }

  async failRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    message: string,
  ) {
    return this.transition(churchId, id, renderAttempt, {
      status: 'FAILED',
      progress: 0,
      errorMessage: message,
    });
  }

  async delete(churchId: string, id: string) {
    if (this.own(churchId, id)) this.db.reels.delete(id);
  }

  async failStaleRenders(olderThan: Date, message: string) {
    let count = 0;
    for (const reel of values(this.db.reels)) {
      if (isRendering(reel.status) && reel.updatedAt < olderThan) {
        Object.assign(reel, {
          status: 'FAILED',
          progress: 0,
          errorMessage: message,
          updatedAt: this.clock.now(),
        });
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryReelCandidateRepository implements ReelCandidateRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async replaceForSermon(
    churchId: string,
    sermonId: string,
    candidates: ReelCandidate[],
  ) {
    for (const [id, row] of this.db.reelCandidates)
      if (row.churchId === churchId && row.sermonId === sermonId)
        this.db.reelCandidates.delete(id);
    const ranks = new Set<number>();
    for (const candidate of candidates) {
      if (ranks.has(candidate.rank))
        throw new Error('Unique violation: (sermon_id, rank)');
      ranks.add(candidate.rank);
      this.db.reelCandidates.set(candidate.id, clone(candidate));
    }
  }

  async listForSermon(churchId: string, sermonId: string) {
    return values(this.db.reelCandidates)
      .filter((row) => row.churchId === churchId && row.sermonId === sermonId)
      .sort((a, b) => a.rank - b.rank)
      .map(clone);
  }

  async findById(churchId: string, id: string) {
    const row = this.db.reelCandidates.get(id);
    return row && row.churchId === churchId ? clone(row) : null;
  }
}

/**
 * Renderer double: records every request and writes small placeholder files, so the rest of the
 * pipeline (storage, assets, state, usage) runs for real. Tests can script a failure.
 */
export class FakeReelRenderer implements ReelRendererPort {
  readonly renders: Array<Omit<RenderReelInput, 'onStage' | 'signal'>> = [];
  readonly stages: ReelRenderStage[] = [];
  /** Next render throws this error (once). */
  failNext: Error | null = null;
  probed: ProbedVideo = {
    width: 1920,
    height: 1080,
    durationMs: 3_600_000,
    hasAudio: true,
  };
  /** Runs inside render(), before the encode finishes (simulate edits/deletes mid-render). */
  duringRender: (() => Promise<void>) | null = null;

  async probe(): Promise<ProbedVideo> {
    return { ...this.probed };
  }

  async render(input: RenderReelInput): Promise<RenderedReel> {
    const { signal: _signal, ...rest } = input;
    const recorded = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key !== 'onStage'),
    ) as Omit<RenderReelInput, 'onStage' | 'signal'>;
    this.renders.push(structuredClone(recorded));
    for (const stage of [
      'ADDING_HOOK',
      'ADDING_CAPTIONS',
      'BRANDING',
      'ENCODING',
    ] as const) {
      this.stages.push(stage);
      await input.onStage(stage);
    }
    await this.duringRender?.();
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const filePath = join(input.workDir, 'reel.mp4');
    const thumbnailPath = join(input.workDir, 'reel-thumb.jpg');
    await writeFile(filePath, Buffer.from('fake-reel-video-bytes'));
    await writeFile(thumbnailPath, Buffer.from('fake-thumb'));
    const clipMs = input.endMs - input.startMs;
    return {
      filePath,
      contentType: 'video/mp4',
      width: input.width,
      height: input.height,
      durationMs: clipMs + (input.outro?.durationMs ?? 0),
      thumbnail: {
        filePath: thumbnailPath,
        contentType: 'image/jpeg',
        width: input.width,
        height: input.height,
      },
    };
  }
}

/** Tracker double: returns scripted samples (speaker on the right third by default). */
export class FakeSpeakerTracker implements SpeakerTrackingPort {
  calls = 0;
  result: TrackingResult = {
    provider: 'fake',
    samples: [
      { tMs: 0, cx: 0.7, confidence: 0.9 },
      { tMs: 10_000, cx: 0.72, confidence: 0.9 },
    ],
  };

  async analyze(): Promise<TrackingResult> {
    this.calls += 1;
    return clone(this.result);
  }
}
