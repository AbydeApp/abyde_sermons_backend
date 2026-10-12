import type { ReelView } from '../../application/reel-presenter.js';
import type { ReelCandidate } from '../../domain/reel-candidates.js';

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export const toReelResponse = (view: ReelView) => ({
  ...view,
  approvedAt: iso(view.approvedAt),
  renderedAt: iso(view.renderedAt),
  createdAt: view.createdAt.toISOString(),
  updatedAt: view.updatedAt.toISOString(),
});

export const toCandidateResponse = (candidate: ReelCandidate) => ({
  id: candidate.id,
  sermonId: candidate.sermonId,
  rank: candidate.rank,
  title: candidate.title,
  startMs: candidate.startMs,
  endMs: candidate.endMs,
  durationMs: candidate.endMs - candidate.startMs,
  transcript: candidate.transcript,
  reason: candidate.reason,
  scores: candidate.scores,
  score: candidate.score,
  createdAt: candidate.createdAt.toISOString(),
});
