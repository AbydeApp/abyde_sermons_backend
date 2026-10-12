import { Inject, Injectable } from '@nestjs/common';
import type {
  Prisma,
  Reel as ReelRow,
  ReelCandidate as ReelCandidateRow,
} from '../../../../generated/prisma/client.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../../../shared/domain/pagination.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  CaptionPosition,
  CaptionStyle,
  HookStyle,
} from '../../../brand/domain/video-settings.js';
import type {
  CandidateScores,
  ReelCandidate,
} from '../../domain/reel-candidates.js';
import {
  REEL_RENDER_STAGES,
  type Reel,
  type ReelHook,
  type ReelRenderStage,
} from '../../domain/reel.js';
import type {
  CompletedRender,
  ReelCandidateRepositoryPort,
  ReelFilter,
  ReelRepositoryPort,
} from '../../application/ports/out/reel.ports.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const RENDERING = [...REEL_RENDER_STAGES];

const toReel = (row: ReelRow): Reel => ({
  id: row.id,
  churchId: row.churchId,
  sermonId: row.sermonId,
  candidateId: row.candidateId,
  title: row.title,
  startMs: row.startTimeMs,
  endMs: row.endTimeMs,
  transcript: row.transcript,
  hook:
    row.hookText && row.hookStyle
      ? { text: row.hookText, style: row.hookStyle as HookStyle }
      : null,
  hookOptions: Array.isArray(row.hookOptions)
    ? (row.hookOptions as unknown as ReelHook[])
    : [],
  captionStyle: row.captionStyle as CaptionStyle,
  captionPosition: row.captionPosition as CaptionPosition,
  status: row.status,
  progress: row.progress,
  renderAttempt: row.renderAttempt,
  editedSinceRender: row.editedSinceRender,
  outputAssetId: row.outputAssetId,
  thumbnailAssetId: row.thumbnailAssetId,
  durationMs: row.durationMs,
  sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  errorMessage: row.errorMessage,
  approvedAt: row.approvedAt,
  renderRequestedAt: row.renderRequestedAt,
  renderedAt: row.renderedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Every column a save may change (ids, church and sermon never change). */
const writable = (reel: Reel) => ({
  candidateId: reel.candidateId,
  title: reel.title,
  startTimeMs: reel.startMs,
  endTimeMs: reel.endMs,
  transcript: reel.transcript,
  hookText: reel.hook?.text ?? null,
  hookStyle: reel.hook?.style ?? null,
  hookOptions: json(reel.hookOptions),
  captionStyle: reel.captionStyle,
  captionPosition: reel.captionPosition,
  status: reel.status,
  progress: reel.progress,
  renderAttempt: reel.renderAttempt,
  editedSinceRender: reel.editedSinceRender,
  outputAssetId: reel.outputAssetId,
  thumbnailAssetId: reel.thumbnailAssetId,
  durationMs: reel.durationMs,
  sizeBytes: reel.sizeBytes === null ? null : BigInt(reel.sizeBytes),
  errorMessage: reel.errorMessage,
  approvedAt: reel.approvedAt,
  renderRequestedAt: reel.renderRequestedAt,
  renderedAt: reel.renderedAt,
});

@Injectable()
export class PrismaReelRepository implements ReelRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async insert(reel: Reel): Promise<void> {
    await this.prisma.db.reel.create({
      data: {
        id: reel.id,
        churchId: reel.churchId,
        sermonId: reel.sermonId,
        createdAt: reel.createdAt,
        ...writable(reel),
      },
    });
  }

  async findById(churchId: string, id: string): Promise<Reel | null> {
    const row = await this.prisma.db.reel.findFirst({
      where: { id, churchId },
    });
    return row ? toReel(row) : null;
  }

  async list(
    churchId: string,
    filter: ReelFilter,
    page: PageRequest,
  ): Promise<Page<Reel>> {
    const where: Prisma.ReelWhereInput = {
      churchId,
      ...(filter.sermonId ? { sermonId: filter.sermonId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    // Sequential: may run inside a transaction, which has a single connection.
    const rows = await this.prisma.db.reel.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: skipFor(page),
      take: page.pageSize,
    });
    const total = await this.prisma.db.reel.count({ where });
    return { items: rows.map(toReel), total, ...page };
  }

  async save(reel: Reel): Promise<void> {
    await this.prisma.db.reel.updateMany({
      where: { id: reel.id, churchId: reel.churchId },
      data: writable(reel),
    });
  }

  countRendering(churchId: string): Promise<number> {
    return this.prisma.db.reel.count({
      where: { churchId, status: { in: RENDERING } },
    });
  }

  async advanceRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    stage: ReelRenderStage,
    progress: number,
  ): Promise<boolean> {
    const { count } = await this.prisma.db.reel.updateMany({
      where: { id, churchId, renderAttempt, status: { in: RENDERING } },
      data: { status: stage, progress },
    });
    return count === 1;
  }

  async completeRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    result: CompletedRender,
  ): Promise<boolean> {
    const { count } = await this.prisma.db.reel.updateMany({
      where: { id, churchId, renderAttempt, status: { in: RENDERING } },
      data: {
        status: 'COMPLETED',
        progress: 100,
        editedSinceRender: false,
        errorMessage: null,
        outputAssetId: result.outputAssetId,
        thumbnailAssetId: result.thumbnailAssetId,
        durationMs: result.durationMs,
        sizeBytes: BigInt(result.sizeBytes),
        renderedAt: result.renderedAt,
      },
    });
    return count === 1;
  }

  async failRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    message: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.db.reel.updateMany({
      where: { id, churchId, renderAttempt, status: { in: RENDERING } },
      data: { status: 'FAILED', progress: 0, errorMessage: message },
    });
    return count === 1;
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.reel.deleteMany({ where: { id, churchId } });
  }

  async failStaleRenders(olderThan: Date, message: string): Promise<number> {
    const { count } = await this.prisma.client.reel.updateMany({
      where: { status: { in: RENDERING }, updatedAt: { lt: olderThan } },
      data: { status: 'FAILED', progress: 0, errorMessage: message },
    });
    return count;
  }
}

const toCandidate = (row: ReelCandidateRow): ReelCandidate => ({
  id: row.id,
  churchId: row.churchId,
  sermonId: row.sermonId,
  rank: row.rank,
  title: row.title,
  startMs: row.startTimeMs,
  endMs: row.endTimeMs,
  transcript: row.transcript,
  reason: row.reason,
  scores: row.scores as unknown as CandidateScores,
  score: row.score,
  createdAt: row.createdAt,
});

/** Bounded: the domain never keeps more than ten per sermon. */
const MAX_CANDIDATES = 50;

@Injectable()
export class PrismaReelCandidateRepository implements ReelCandidateRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async replaceForSermon(
    churchId: string,
    sermonId: string,
    candidates: ReelCandidate[],
  ): Promise<void> {
    await this.prisma.db.reelCandidate.deleteMany({
      where: { churchId, sermonId },
    });
    if (candidates.length === 0) return;
    await this.prisma.db.reelCandidate.createMany({
      data: candidates.map((candidate) => ({
        id: candidate.id,
        churchId,
        sermonId,
        rank: candidate.rank,
        title: candidate.title,
        startTimeMs: candidate.startMs,
        endTimeMs: candidate.endMs,
        transcript: candidate.transcript,
        reason: candidate.reason,
        scores: json(candidate.scores),
        score: candidate.score,
        createdAt: candidate.createdAt,
      })),
    });
  }

  async listForSermon(
    churchId: string,
    sermonId: string,
  ): Promise<ReelCandidate[]> {
    const rows = await this.prisma.db.reelCandidate.findMany({
      where: { churchId, sermonId },
      orderBy: { rank: 'asc' },
      take: MAX_CANDIDATES,
    });
    return rows.map(toCandidate);
  }

  async findById(churchId: string, id: string): Promise<ReelCandidate | null> {
    const row = await this.prisma.db.reelCandidate.findFirst({
      where: { id, churchId },
    });
    return row ? toCandidate(row) : null;
  }
}
