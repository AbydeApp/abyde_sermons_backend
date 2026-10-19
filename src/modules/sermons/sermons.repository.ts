import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type Sermon as SermonRow } from '../../generated/prisma/client.js';
import { lagosYearRange } from '../../shared/domain/lagos-time.js';
import { type Page, type PageRequest, skipFor } from '../../shared/domain/pagination.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import {
  PROCESSING_STATUSES,
  type ScriptureReferenceRecord,
  type SegmentDraft,
  Sermon,
  type SermonAssetRecord,
  type SermonFilter,
  type SermonIntelligence,
  type SermonProps,
  type SermonView,
  type TranscriptSegmentRecord,
  type TranscriptWord,
} from './helper.js';

export const SERMON_REPOSITORY = Symbol('SERMON_REPOSITORY');

export interface SermonRepositoryPort {
  /** Always scoped: a sermon from another church is indistinguishable from a missing one. */
  findById(churchId: string, id: string): Promise<Sermon | null>;
  insert(sermon: Sermon): Promise<void>;
  /** Writes only the user-editable details. False when the sermon no longer exists. */
  updateDetails(sermon: Sermon): Promise<boolean>;
  /**
   * Writes only processing state (status, stage, failure, analysis results), and only if the stored
   * sermon is still being processed in the same run (`processingAttempts`). Returns false when the
   * sermon was deleted, finished, failed or retried meanwhile, so a stale worker can never
   * resurrect a deleted sermon, overwrite a user's edit or regress a finished one.
   */
  updateProcessing(sermon: Sermon): Promise<boolean>;
  /** FAILED → QUEUED for a new run. False when the stored sermon is not the failed run being retried. */
  updateForRetry(sermon: Sermon): Promise<boolean>;
  addAsset(asset: SermonAssetRecord): Promise<void>;
  findAssets(churchId: string, sermonId: string): Promise<SermonAssetRecord[]>;
  /** Maintenance only (all churches): originals past retention that are still stored. */
  findExpiredAssets(now: Date, limit: number): Promise<SermonAssetRecord[]>;
  markAssetDeleted(churchId: string, id: string, at: Date): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  /** Maintenance only (all churches): sermons still processing with no change since `olderThan`. */
  findStuckProcessing(olderThan: Date, limit: number): Promise<Sermon[]>;
}

export const SERMON_QUERY = Symbol('SERMON_QUERY');

export interface SermonQueryPort {
  list(
    churchId: string,
    filter: SermonFilter,
    page: PageRequest,
  ): Promise<Page<SermonView>>;
  findView(churchId: string, id: string): Promise<SermonView | null>;
  /** Views in the order of `ids` (ids from other churches are dropped). */
  findViews(churchId: string, ids: string[]): Promise<SermonView[]>;
  /** Ids of READY sermons matching the filter (for semantic re-ranking). */
  matchingIds(churchId: string, filter: SermonFilter): Promise<string[]>;
  latest(churchId: string): Promise<SermonView | null>;
}

export const TRANSCRIPT_REPOSITORY = Symbol('TRANSCRIPT_REPOSITORY');

export interface TranscriptRepositoryPort {
  /** Raw text supplied at creation (pasted transcript), before segmentation. */
  saveSourceText(input: {
    id: string;
    churchId: string;
    sermonId: string;
    text: string;
  }): Promise<void>;
  findSourceText(churchId: string, sermonId: string): Promise<string | null>;
  /** Replaces any previous transcript + segments for the sermon (idempotent re-runs). */
  replace(input: {
    churchId: string;
    sermonId: string;
    transcriptId: string;
    fullText: string;
    language: string | null;
    provider: string;
    segments: Array<SegmentDraft & { id: string }>;
  }): Promise<void>;
  countSegments(churchId: string, sermonId: string): Promise<number>;
  /** Segments without word timings (the common, lighter read). */
  listSegments(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]>;
  /** Segments including word timings, for captions and Reel selection. */
  listSegmentsWithWords(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]>;
  /** Segments by id, restricted to the church (used to resolve content sources). */
  findSegments(
    churchId: string,
    ids: string[],
  ): Promise<Array<TranscriptSegmentRecord & { sermonId: string }>>;
}

export const INTELLIGENCE_REPOSITORY = Symbol('INTELLIGENCE_REPOSITORY');

export interface IntelligenceRepositoryPort {
  upsert(input: {
    id: string;
    churchId: string;
    sermonId: string;
    data: SermonIntelligence;
    aiProvider: string;
    aiModel: string;
  }): Promise<void>;
  find(churchId: string, sermonId: string): Promise<SermonIntelligence | null>;
  replaceScriptures(
    churchId: string,
    sermonId: string,
    references: ScriptureReferenceRecord[],
  ): Promise<void>;
  listScriptures(
    churchId: string,
    sermonId: string,
  ): Promise<ScriptureReferenceRecord[]>;
  /** Batched variant for list views (one query for many sermons). */
  listScripturesForSermons(
    churchId: string,
    sermonIds: string[],
  ): Promise<ScriptureReferenceRecord[]>;
}

export const EMBEDDING_REPOSITORY = Symbol('EMBEDDING_REPOSITORY');

export interface EmbeddingRow {
  id: string;
  churchId: string;
  sermonId: string;
  transcriptSegmentId: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface SegmentMatch {
  sermonId: string;
  segmentId: string;
  content: string;
  /** Cosine similarity in [−1, 1]; higher is closer. */
  similarity: number;
}

export interface EmbeddingRepositoryPort {
  replaceForSermon(
    churchId: string,
    sermonId: string,
    rows: EmbeddingRow[],
  ): Promise<void>;
  /** Nearest segments within one church (READY sermons only), optionally limited to some sermons. */
  searchSegments(
    churchId: string,
    vector: number[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]>;
  /**
   * Fallback when no query vector is available: segments of the church containing the given
   * words, scored by the share of words matched (0–1).
   */
  searchSegmentsByKeyword(
    churchId: string,
    keywords: string[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]>;
}

export const toSermon = (row: SermonRow): Sermon =>
  Sermon.restore({
    id: row.id,
    churchId: row.churchId,
    title: row.title,
    speaker: row.speaker,
    sermonDate: row.sermonDate,
    series: row.series,
    mainScripture: row.mainScripture,
    tags: row.tags,
    status: row.status,
    processingStage: row.processingStage,
    failedStage: row.failedStage,
    errorMessage: row.errorMessage,
    canRetry: row.canRetry,
    sourceType: row.sourceType,
    summary: row.summary,
    mainTheme: row.mainTheme,
    themes: row.themes,
    scriptures: row.scriptures,
    durationMs: row.durationMs,
    processingAttempts: row.processingAttempts,
    readyAt: row.readyAt,
    createdAt: row.createdAt,
  });

export const toSermonData = (props: Readonly<SermonProps>) => ({ ...props });

export const toSermonView = (
  row: SermonRow,
  contentCount: number,
): SermonView => ({
  id: row.id,
  title: row.title,
  speaker: row.speaker,
  sermonDate: row.sermonDate,
  series: row.series,
  mainScripture: row.mainScripture,
  tags: row.tags,
  status: row.status,
  processingStage: row.status === 'READY' ? null : row.processingStage,
  summary: row.summary,
  mainTheme: row.mainTheme,
  scriptures: row.scriptures,
  themes: row.themes,
  contentCount,
  createdAt: row.createdAt,
});

@Injectable()
export class PrismaSermonRepository implements SermonRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(churchId: string, id: string): Promise<Sermon | null> {
    const row = await this.prisma.db.sermon.findFirst({
      where: { id, churchId },
    });
    return row ? toSermon(row) : null;
  }

  async insert(sermon: Sermon): Promise<void> {
    await this.prisma.db.sermon.create({
      data: toSermonData(sermon.snapshot()),
    });
  }

  async updateDetails(sermon: Sermon): Promise<boolean> {
    const {
      id,
      churchId,
      title,
      speaker,
      sermonDate,
      series,
      mainScripture,
      tags,
    } = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: { id, churchId },
      data: { title, speaker, sermonDate, series, mainScripture, tags },
    });
    return result.count === 1;
  }

  async updateProcessing(sermon: Sermon): Promise<boolean> {
    const props = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: {
        id: props.id,
        churchId: props.churchId,
        processingAttempts: props.processingAttempts,
        status: { in: PROCESSING_STATUSES },
      },
      data: {
        status: props.status,
        processingStage: props.processingStage,
        failedStage: props.failedStage,
        errorMessage: props.errorMessage,
        canRetry: props.canRetry,
        summary: props.summary,
        mainTheme: props.mainTheme,
        themes: props.themes,
        scriptures: props.scriptures,
        durationMs: props.durationMs,
        readyAt: props.readyAt,
      },
    });
    return result.count === 1;
  }

  async updateForRetry(sermon: Sermon): Promise<boolean> {
    const props = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: {
        id: props.id,
        churchId: props.churchId,
        status: 'FAILED',
        processingAttempts: props.processingAttempts - 1,
      },
      data: {
        status: props.status,
        processingStage: props.processingStage,
        failedStage: props.failedStage,
        errorMessage: props.errorMessage,
        canRetry: props.canRetry,
        processingAttempts: props.processingAttempts,
      },
    });
    return result.count === 1;
  }

  async addAsset(asset: SermonAssetRecord): Promise<void> {
    await this.prisma.db.sermonAsset.create({
      data: { ...asset, sizeBytes: BigInt(asset.sizeBytes) },
    });
  }

  async findAssets(
    churchId: string,
    sermonId: string,
  ): Promise<SermonAssetRecord[]> {
    const rows = await this.prisma.db.sermonAsset.findMany({
      where: { churchId, sermonId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  async findExpiredAssets(
    now: Date,
    limit: number,
  ): Promise<SermonAssetRecord[]> {
    const rows = await this.prisma.db.sermonAsset.findMany({
      where: { deletedAt: null, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  async markAssetDeleted(
    churchId: string,
    id: string,
    at: Date,
  ): Promise<void> {
    await this.prisma.db.sermonAsset.updateMany({
      where: { id, churchId, deletedAt: null },
      data: { deletedAt: at },
    });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.sermon.deleteMany({ where: { id, churchId } });
  }

  async findStuckProcessing(olderThan: Date, limit: number): Promise<Sermon[]> {
    const rows = await this.prisma.db.sermon.findMany({
      where: {
        status: { in: PROCESSING_STATUSES },
        updatedAt: { lt: olderThan },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(toSermon);
  }
}

const insensitive = (value: string) => ({
  equals: value,
  mode: 'insensitive' as const,
});

export function sermonWhere(
  churchId: string,
  filter: SermonFilter,
): Prisma.SermonWhereInput {
  const and: Prisma.SermonWhereInput[] = [{ churchId }];
  if (filter.statuses?.length) and.push({ status: { in: filter.statuses } });
  if (filter.q) {
    const contains = { contains: filter.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { speaker: contains },
        { series: contains },
        { mainScripture: contains },
      ],
    });
  }
  if (filter.speaker) and.push({ speaker: insensitive(filter.speaker) });
  if (filter.series) and.push({ series: insensitive(filter.series) });
  if (filter.scripture)
    and.push({
      OR: [
        { scriptures: { has: filter.scripture } },
        { mainScripture: insensitive(filter.scripture) },
      ],
    });
  if (filter.theme) and.push({ themes: { has: filter.theme } });
  if (filter.tag) and.push({ tags: { has: filter.tag.toLowerCase() } });
  if (filter.year) {
    const { start, end } = lagosYearRange(filter.year);
    and.push({ sermonDate: { gte: start, lt: end } });
  }
  return { AND: and };
}

const ORDER: Prisma.SermonOrderByWithRelationInput[] = [
  { sermonDate: 'desc' },
  { createdAt: 'desc' },
];

@Injectable()
export class PrismaSermonQuery implements SermonQueryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    churchId: string,
    filter: SermonFilter,
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    const where = sermonWhere(churchId, filter);
    const [total, rows] = await Promise.all([
      this.prisma.db.sermon.count({ where }),
      this.prisma.db.sermon.findMany({
        where,
        orderBy: ORDER,
        skip: skipFor(page),
        take: page.pageSize,
      }),
    ]);
    const counts = await this.contentCounts(
      churchId,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toSermonView(row, counts.get(row.id) ?? 0)),
      total,
      ...page,
    };
  }

  async findView(churchId: string, id: string): Promise<SermonView | null> {
    const [view] = await this.findViews(churchId, [id]);
    return view ?? null;
  }

  async findViews(churchId: string, ids: string[]): Promise<SermonView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.db.sermon.findMany({
      where: { churchId, id: { in: ids } },
    });
    const counts = await this.contentCounts(
      churchId,
      rows.map((row) => row.id),
    );
    const byId = new Map(
      rows.map((row) => [row.id, toSermonView(row, counts.get(row.id) ?? 0)]),
    );
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async matchingIds(churchId: string, filter: SermonFilter): Promise<string[]> {
    const rows = await this.prisma.db.sermon.findMany({
      where: sermonWhere(churchId, filter),
      select: { id: true },
      take: 5000,
    });
    return rows.map((row) => row.id);
  }

  async latest(churchId: string): Promise<SermonView | null> {
    const row = await this.prisma.db.sermon.findFirst({
      where: { churchId, status: { not: 'ARCHIVED' } },
      orderBy: ORDER,
    });
    if (!row) return null;
    const counts = await this.contentCounts(churchId, [row.id]);
    return toSermonView(row, counts.get(row.id) ?? 0);
  }

  /** One grouped query for the whole page (no N+1). */
  private async contentCounts(
    churchId: string,
    sermonIds: string[],
  ): Promise<Map<string, number>> {
    if (sermonIds.length === 0) return new Map();
    const groups = await this.prisma.db.contentItem.groupBy({
      by: ['sermonId'],
      where: {
        churchId,
        sermonId: { in: sermonIds },
        status: { not: 'ARCHIVED' },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.sermonId, group._count._all]));
  }
}

const MAX_SEGMENTS_PER_SERMON = 2000;
const SEGMENT_SELECT = {
  id: true,
  sequence: true,
  startTimeMs: true,
  endTimeMs: true,
  text: true,
  speakerLabel: true,
} as const;
const INSERT_BATCH = 500;

/** Words are stored compactly as `[text, startMs, endMs]` tuples (about a third of the object form). */
type StoredWord = [string, number, number];

export const encodeWords = (
  words: TranscriptWord[] | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  words && words.length > 0
    ? words.map((word): StoredWord => [word.text, word.startMs, word.endMs])
    : Prisma.DbNull;

export function decodeWords(value: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const words: TranscriptWord[] = [];
  for (const entry of value) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'number' &&
      typeof entry[2] === 'number'
    )
      words.push({ text: entry[0], startMs: entry[1], endMs: entry[2] });
  }
  return words.length > 0 ? words : undefined;
}

@Injectable()
export class PrismaTranscriptRepository implements TranscriptRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async saveSourceText(input: {
    id: string;
    churchId: string;
    sermonId: string;
    text: string;
  }): Promise<void> {
    await this.prisma.db.transcript.create({
      data: {
        id: input.id,
        churchId: input.churchId,
        sermonId: input.sermonId,
        fullText: input.text,
        provider: 'pasted',
      },
    });
  }

  async findSourceText(
    churchId: string,
    sermonId: string,
  ): Promise<string | null> {
    const row = await this.prisma.db.transcript.findFirst({
      where: { churchId, sermonId },
      select: { fullText: true },
    });
    return row?.fullText ?? null;
  }

  async replace(input: {
    churchId: string;
    sermonId: string;
    transcriptId: string;
    fullText: string;
    language: string | null;
    provider: string;
    segments: Array<SegmentDraft & { id: string }>;
  }): Promise<void> {
    const db = this.prisma.db;
    await db.transcript.deleteMany({
      where: { churchId: input.churchId, sermonId: input.sermonId },
    }); // cascades segments
    await db.transcript.create({
      data: {
        id: input.transcriptId,
        churchId: input.churchId,
        sermonId: input.sermonId,
        fullText: input.fullText,
        language: input.language,
        provider: input.provider,
      },
    });
    for (let start = 0; start < input.segments.length; start += INSERT_BATCH) {
      await db.transcriptSegment.createMany({
        data: input.segments
          .slice(start, start + INSERT_BATCH)
          .map((segment) => ({
            id: segment.id,
            churchId: input.churchId,
            sermonId: input.sermonId,
            transcriptId: input.transcriptId,
            sequence: segment.sequence,
            startTimeMs: segment.startTimeMs,
            endTimeMs: segment.endTimeMs,
            text: segment.text,
            words: encodeWords(segment.words),
          })),
      });
    }
  }

  countSegments(churchId: string, sermonId: string): Promise<number> {
    return this.prisma.db.transcriptSegment.count({
      where: { churchId, sermonId },
    });
  }

  listSegments(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]> {
    return this.prisma.db.transcriptSegment.findMany({
      where: { churchId, sermonId },
      orderBy: { sequence: 'asc' },
      // A 3-hour sermon is about 240 segments; this is a safety bound, not a page size.
      take: MAX_SEGMENTS_PER_SERMON,
      select: SEGMENT_SELECT,
    });
  }

  async listSegmentsWithWords(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]> {
    const rows = await this.prisma.db.transcriptSegment.findMany({
      where: { churchId, sermonId },
      orderBy: { sequence: 'asc' },
      take: MAX_SEGMENTS_PER_SERMON,
      select: { ...SEGMENT_SELECT, words: true },
    });
    return rows.map(({ words, ...segment }) => {
      const decoded = decodeWords(words);
      return decoded ? { ...segment, words: decoded } : segment;
    });
  }

  findSegments(
    churchId: string,
    ids: string[],
  ): Promise<Array<TranscriptSegmentRecord & { sermonId: string }>> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.db.transcriptSegment.findMany({
      where: { churchId, id: { in: ids } },
      select: { ...SEGMENT_SELECT, sermonId: true },
      orderBy: { sequence: 'asc' },
    });
  }
}

@Injectable()
export class PrismaIntelligenceRepository implements IntelligenceRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async upsert(input: {
    id: string;
    churchId: string;
    sermonId: string;
    data: SermonIntelligence;
    aiProvider: string;
    aiModel: string;
  }): Promise<void> {
    const data = input.data as unknown as Prisma.InputJsonValue;
    await this.prisma.db.sermonIntelligence.upsert({
      where: { sermonId: input.sermonId },
      create: {
        id: input.id,
        churchId: input.churchId,
        sermonId: input.sermonId,
        data,
        aiProvider: input.aiProvider,
        aiModel: input.aiModel,
      },
      update: { data, aiProvider: input.aiProvider, aiModel: input.aiModel },
    });
  }

  async find(
    churchId: string,
    sermonId: string,
  ): Promise<SermonIntelligence | null> {
    const row = await this.prisma.db.sermonIntelligence.findFirst({
      where: { churchId, sermonId },
      select: { data: true },
    });
    return row ? (row.data as unknown as SermonIntelligence) : null;
  }

  async replaceScriptures(
    churchId: string,
    sermonId: string,
    references: ScriptureReferenceRecord[],
  ): Promise<void> {
    await this.prisma.db.scriptureReference.deleteMany({
      where: { churchId, sermonId },
    });
    if (references.length > 0)
      await this.prisma.db.scriptureReference.createMany({ data: references });
  }

  listScriptures(
    churchId: string,
    sermonId: string,
  ): Promise<ScriptureReferenceRecord[]> {
    return this.listScripturesForSermons(churchId, [sermonId]);
  }

  listScripturesForSermons(
    churchId: string,
    sermonIds: string[],
  ): Promise<ScriptureReferenceRecord[]> {
    if (sermonIds.length === 0) return Promise.resolve([]);
    return this.prisma.db.scriptureReference.findMany({
      where: { churchId, sermonId: { in: sermonIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        churchId: true,
        sermonId: true,
        book: true,
        chapter: true,
        verseStart: true,
        verseEnd: true,
        translation: true,
        verified: true,
        display: true,
        sourceSegmentId: true,
      },
    });
  }
}

const vectorLiteral = (vector: number[]): string =>
  `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;

@Injectable()
export class PrismaEmbeddingRepository implements EmbeddingRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async replaceForSermon(
    churchId: string,
    sermonId: string,
    rows: EmbeddingRow[],
  ): Promise<void> {
    const db = this.prisma.db;
    await db.sermonEmbedding.deleteMany({ where: { churchId, sermonId } });
    for (let start = 0; start < rows.length; start += 100) {
      const values = rows
        .slice(start, start + 100)
        .map(
          (row) =>
            Prisma.sql`(${row.id}::uuid, ${row.churchId}::uuid, ${row.sermonId}::uuid, ${row.transcriptSegmentId}::uuid, ${row.content}, ${vectorLiteral(row.embedding)}::vector, ${JSON.stringify(row.metadata)}::jsonb)`,
        );
      await db.$executeRaw`INSERT INTO "sermon_embeddings" ("id", "church_id", "sermon_id", "transcript_segment_id", "content", "embedding", "metadata") VALUES ${Prisma.join(values)}`;
    }
  }

  async searchSegments(
    churchId: string,
    vector: number[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]> {
    if (options.sermonIds && options.sermonIds.length === 0) return [];
    const literal = vectorLiteral(vector);
    const sermonFilter = options.sermonIds
      ? Prisma.sql`AND e."sermon_id" = ANY(${options.sermonIds}::uuid[])`
      : Prisma.empty;
    // church_id is filtered inside the ANN scan; iterative scanning keeps recall when one church is a small slice of the index.
    const [, , rows] = await this.prisma.client.$transaction([
      this.prisma.client
        .$executeRaw`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
      this.prisma.client
        .$executeRaw`SELECT set_config('hnsw.ef_search', '100', true)`,
      this.prisma.client.$queryRaw<
        Array<{
          sermon_id: string;
          segment_id: string;
          content: string;
          similarity: number;
        }>
      >`
        SELECT e."sermon_id", e."transcript_segment_id" AS segment_id, e."content",
               1 - (e."embedding" <=> ${literal}::vector) AS similarity
        FROM "sermon_embeddings" e
        JOIN "sermons" s ON s."id" = e."sermon_id" AND s."church_id" = ${churchId}::uuid AND s."status" = 'READY'
        WHERE e."church_id" = ${churchId}::uuid ${sermonFilter}
        ORDER BY e."embedding" <=> ${literal}::vector
        LIMIT ${options.limit}`,
    ]);
    return rows.map((row) => ({
      sermonId: row.sermon_id,
      segmentId: row.segment_id,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  }

  async searchSegmentsByKeyword(
    churchId: string,
    keywords: string[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]> {
    if (
      keywords.length === 0 ||
      (options.sermonIds && options.sermonIds.length === 0)
    )
      return [];
    // Each keyword is a bound parameter; LIKE wildcards inside it are escaped.
    const patterns = keywords.map(
      (word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`,
    );
    const score = Prisma.join(
      patterns.map(
        (pattern) =>
          Prisma.sql`(CASE WHEN e."content" ILIKE ${pattern} THEN 1 ELSE 0 END)`,
      ),
      ' + ',
    );
    const sermonFilter = options.sermonIds
      ? Prisma.sql`AND e."sermon_id" = ANY(${options.sermonIds}::uuid[])`
      : Prisma.empty;
    const rows = await this.prisma.db.$queryRaw<
      Array<{
        sermon_id: string;
        segment_id: string;
        content: string;
        hits: number;
      }>
    >`
      SELECT e."sermon_id", e."transcript_segment_id" AS segment_id, e."content", (${score})::int AS hits
      FROM "sermon_embeddings" e
      JOIN "sermons" s ON s."id" = e."sermon_id" AND s."church_id" = ${churchId}::uuid AND s."status" = 'READY'
      WHERE e."church_id" = ${churchId}::uuid ${sermonFilter} AND (${score}) > 0
      ORDER BY hits DESC, e."created_at" DESC
      LIMIT ${options.limit}`;
    return rows.map((row) => ({
      sermonId: row.sermon_id,
      segmentId: row.segment_id,
      content: row.content,
      similarity: Number(row.hits) / keywords.length,
    }));
  }
}
