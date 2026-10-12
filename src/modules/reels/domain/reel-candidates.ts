import type { Sentence } from './transcript-sentences.js';

/** What makes a moment work as a standalone Reel, each scored 1–10 by the model. */
export interface CandidateScores {
  standalone: number;
  impact: number;
  quotability: number;
  contextIndependence: number;
}

/** A model's suggestion, referring to sentences by index. Everything else is derived and checked here. */
export interface CandidateProposal {
  startSentence: number;
  endSentence: number;
  title: string;
  reason: string;
  scores: CandidateScores;
}

export interface ReelCandidateDraft {
  rank: number;
  title: string;
  startMs: number;
  endMs: number;
  /** Exactly what the pastor says in the window (built from the transcript, never from the model). */
  transcript: string;
  reason: string;
  scores: CandidateScores;
  /** Weighted score in [0, 1]. */
  score: number;
}

export interface ReelCandidate extends ReelCandidateDraft {
  id: string;
  churchId: string;
  sermonId: string;
  createdAt: Date;
}

export interface CandidateRules {
  minMs: number;
  maxMs: number;
  maxCandidates: number;
  /** Two candidates may share at most this fraction of the shorter one. */
  maxOverlap: number;
}

export const DEFAULT_CANDIDATE_RULES: CandidateRules = {
  minMs: 15_000,
  maxMs: 90_000,
  maxCandidates: 10,
  maxOverlap: 0.3,
};

/** Breath before the first word and a beat after the last, without catching neighbouring words. */
const LEAD_IN_MS = 150;
const TAIL_MS = 400;

const WEIGHTS: CandidateScores = {
  standalone: 0.3,
  impact: 0.25,
  quotability: 0.2,
  contextIndependence: 0.25,
};

const clampScore = (value: number): number =>
  Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : 1;

export function weightedScore(scores: CandidateScores): number {
  const total = (Object.keys(WEIGHTS) as Array<keyof CandidateScores>).reduce(
    (sum, key) => sum + WEIGHTS[key] * (clampScore(scores[key]) - 1),
    0,
  );
  return Math.round((total / 9) * 1000) / 1000;
}

const overlapRatio = (
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number => {
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shared <= 0 || shorter <= 0 ? 0 : shared / shorter;
};

/**
 * Turns model proposals into Reel candidates the product can trust:
 * - boundaries snap to whole sentences (clean in and out points, with a little breathing room),
 * - windows are stretched or trimmed by whole sentences to fit the allowed duration,
 * - the transcript text comes from the sermon itself, so it is always what was actually said,
 * - overlapping moments are deduplicated, best first, up to `maxCandidates`.
 */
export function selectReelCandidates(
  proposals: CandidateProposal[],
  sentences: Sentence[],
  rules: CandidateRules = DEFAULT_CANDIDATE_RULES,
  sermonDurationMs: number | null = null,
): ReelCandidateDraft[] {
  const last = sentences.length - 1;
  const mediaEnd = sermonDurationMs ?? (sentences[last]?.endMs ?? 0) + TAIL_MS;
  const windowFor = (start: number, end: number) => {
    const first = sentences[start] as Sentence;
    const final = sentences[end] as Sentence;
    const previousEnd = sentences[start - 1]?.endMs ?? 0;
    const nextStart = sentences[end + 1]?.startMs ?? mediaEnd;
    return {
      startMs: Math.max(0, previousEnd, first.startMs - LEAD_IN_MS),
      endMs: Math.min(
        mediaEnd,
        Math.max(final.endMs, Math.min(nextStart, final.endMs + TAIL_MS)),
      ),
    };
  };

  const drafts: Omit<ReelCandidateDraft, 'rank'>[] = [];
  for (const proposal of proposals) {
    // The start is never moved: a candidate begins where the model saw the moment begin.
    const start = Math.trunc(proposal.startSentence);
    let end = Math.trunc(proposal.endSentence);
    if (start < 0 || end > last || end < start) continue;
    let window = windowFor(start, end);
    while (window.endMs - window.startMs < rules.minMs && end < last) {
      end += 1;
      window = windowFor(start, end);
    }
    while (window.endMs - window.startMs > rules.maxMs && end > start) {
      end -= 1;
      window = windowFor(start, end);
    }
    const duration = window.endMs - window.startMs;
    if (duration < rules.minMs || duration > rules.maxMs) continue;
    const title = proposal.title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) continue;
    const scores: CandidateScores = {
      standalone: clampScore(proposal.scores.standalone),
      impact: clampScore(proposal.scores.impact),
      quotability: clampScore(proposal.scores.quotability),
      contextIndependence: clampScore(proposal.scores.contextIndependence),
    };
    drafts.push({
      title,
      ...window,
      transcript: sentences
        .slice(start, end + 1)
        .map((sentence) => sentence.text)
        .join(' '),
      reason: proposal.reason.replace(/\s+/g, ' ').trim().slice(0, 300),
      scores,
      score: weightedScore(scores),
    });
  }

  const chosen: Omit<ReelCandidateDraft, 'rank'>[] = [];
  for (const draft of drafts.sort(
    (a, b) => b.score - a.score || a.startMs - b.startMs,
  )) {
    if (chosen.length >= rules.maxCandidates) break;
    if (chosen.some((other) => overlapRatio(draft, other) > rules.maxOverlap))
      continue;
    chosen.push(draft);
  }
  return chosen.map((draft, index) => ({ ...draft, rank: index + 1 }));
}
