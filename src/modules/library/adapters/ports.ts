import type { SegmentMatch } from '../../sermons/sermons.repository.js';

export const SEGMENT_SEARCH = Symbol('SEGMENT_SEARCH');

export interface SegmentSearchResult {
  matches: SegmentMatch[];
  /** `keyword` when the semantic index could not be used and the fallback answered instead. */
  mode: 'semantic' | 'keyword';
}

/** Finds the transcript segments of one church that best match a piece of text. */
export interface SegmentSearchPort {
  search(
    churchId: string,
    text: string,
    options: { limit: number; sermonIds?: string[]; operation: string },
  ): Promise<SegmentSearchResult>;
}

export const GROUNDED_ANSWER = Symbol('GROUNDED_ANSWER');

export interface AnswerExcerpt {
  sermonTitle: string;
  sermonDate: Date;
  startTimeMs: number;
  text: string;
}

export interface GroundedAnswer {
  sufficientEvidence: boolean;
  answer: string;
  /** 1-based positions in the excerpts that were supplied. */
  citedExcerpts: number[];
}

/** Writes an answer to a question using only the supplied sermon excerpts. */
export interface GroundedAnswerPort {
  answer(input: {
    churchId: string;
    churchName: string | null;
    question: string;
    excerpts: AnswerExcerpt[];
  }): Promise<GroundedAnswer>;
}
