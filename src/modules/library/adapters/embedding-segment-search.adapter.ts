import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CACHE,
  type CachePort,
} from '../../../shared/application/ports/cache.port.js';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../shared/application/ports/language-model.port.js';
import { EMBEDDING_REPOSITORY, type EmbeddingRepositoryPort } from '../../sermons/sermons.repository.js';
import type {
  SegmentSearchPort,
  SegmentSearchResult,
} from './ports.js';

const QUERY_EMBEDDING_TTL_SECONDS = 24 * 3600;
const MAX_KEYWORDS = 8;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'what',
  'has',
  'have',
  'our',
  'about',
  'when',
  'how',
  'did',
  'does',
  'was',
  'were',
  'are',
  'you',
  'your',
  'not',
  'from',
]);

/** Significant words of a query, for the keyword fallback. */
export function keywordsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))].slice(
    0,
    MAX_KEYWORDS,
  );
}

/**
 * Semantic segment search: embeds the query (cached, so repeated searches are not re-billed) and
 * ranks by vector similarity. If the embedding provider is unavailable (outage, open circuit,
 * timeout) it falls back to keyword matching over the same church-scoped segments, so search and
 * Ask keep working with reduced quality instead of failing.
 */
@Injectable()
export class EmbeddingSegmentSearchAdapter implements SegmentSearchPort {
  private readonly logger = new Logger(EmbeddingSegmentSearchAdapter.name);

  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(EMBEDDING_REPOSITORY)
    private readonly embeddings: EmbeddingRepositoryPort,
  ) {}

  async search(
    churchId: string,
    text: string,
    options: { limit: number; sermonIds?: string[]; operation: string },
  ): Promise<SegmentSearchResult> {
    let vector: number[];
    try {
      vector = await this.embed(churchId, text, options.operation);
    } catch (error) {
      this.logger.warn(
        { err: error, operation: options.operation },
        'Embedding unavailable; using keyword search',
      );
      const matches = await this.embeddings.searchSegmentsByKeyword(
        churchId,
        keywordsOf(text),
        options,
      );
      return { matches, mode: 'keyword' };
    }
    return {
      matches: await this.embeddings.searchSegments(churchId, vector, options),
      mode: 'semantic',
    };
  }

  private async embed(
    churchId: string,
    text: string,
    operation: string,
  ): Promise<number[]> {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `query-embedding:${createHash('sha256').update(normalized).digest('hex')}`;
    const cached = await this.cache.get<number[]>(key);
    if (cached) return cached;
    const { vectors } = await this.model.embed({
      context: { operation, churchId },
      inputs: [normalized],
    });
    const vector = vectors[0];
    if (!vector) throw new Error('Embedding provider returned no vector');
    await this.cache.set(key, vector, QUERY_EMBEDDING_TTL_SECONDS);
    return vector;
  }
}
