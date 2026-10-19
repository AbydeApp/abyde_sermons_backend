import { z } from 'zod';
import { pageQuery } from '../../shared/infrastructure/http/pagination.js';
import type { SermonFilter } from '../sermons/helper.js';

// ───────────────────────── Constants ─────────────────────────

export const FACETS_TTL_SECONDS = 60; // short: new sermons appear within a minute
export const facetsCacheKey = (churchId: string) => `library-facets:${churchId}`;

export const SEMANTIC_CANDIDATES = 300;
export const MIN_SIMILARITY = 0.2;

export const ASK_RETRIEVE = 12;
export const MIN_EVIDENCE_SIMILARITY = 0.25;
export const EXCERPT_CHARS = 320;
export const FALLBACK_SOURCES = 3;
export const NO_EVIDENCE_ANSWER =
  "I couldn't find anything in your sermon archive that addresses this question, so I can't say what your church has taught about it.";

// ───────────────────────── Types & functions ─────────────────────────

export type LibraryFilters = Pick<SermonFilter, 'speaker' | 'series' | 'scripture' | 'theme' | 'tag' | 'year'>;

export const hasFilters = (filters: LibraryFilters) =>
  Object.values(filters).some((value) => value !== undefined && value !== '');

export interface AskSource {
  sermonId: string;
  sermonTitle: string;
  segmentId: string;
  startTimeMs: number;
  endTimeMs: number;
  excerpt: string;
}

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
}

export const excerptOf = (text: string): string =>
  text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text;

/** Best similarity per sermon, strongest first; weak matches are dropped. */
export function rankSermons(matches: Array<{ sermonId: string; similarity: number }>): string[] {
  const best = new Map<string, number>();
  for (const match of matches) {
    if (match.similarity < MIN_SIMILARITY) continue;
    best.set(match.sermonId, Math.max(best.get(match.sermonId) ?? -1, match.similarity));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ───────────────────────── Request schemas ─────────────────────────

const optionalText = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((value) => value || undefined);
const filters = {
  speaker: optionalText,
  series: optionalText,
  scripture: optionalText,
  theme: optionalText,
  tag: optionalText,
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  ...pageQuery,
};

export const SearchBody = z.object(filters);
export const SemanticBody = z.object({
  query: z.string({ error: 'Search text is required' }).trim().min(1, 'Search text is required').max(500),
  ...filters,
});
export const AskBody = z.object({
  question: z.string({ error: 'Ask a question' }).trim().min(3, 'Ask a question').max(1000),
});
