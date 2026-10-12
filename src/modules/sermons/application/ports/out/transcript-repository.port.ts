import type { SegmentDraft } from '../../../domain/transcript-segmenter.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../../domain/sermon-intelligence.js';

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
