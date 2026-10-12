import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  EmbeddingRepositoryPort,
  EmbeddingRow,
  IntelligenceRepositoryPort,
  SegmentMatch,
  TranscriptRepositoryPort,
} from '../../application/ports/out/transcript-repository.port.js';
import type {
  SegmentDraft,
  TranscriptWord,
} from '../../domain/transcript-segmenter.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../domain/sermon-intelligence.js';

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
