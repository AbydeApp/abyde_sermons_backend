import { QUEUES } from './ports/queue.port.js';

/**
 * Job contract between the sermon pipeline (producer, once a sermon is READY) and the reels module
 * (consumer). Kept in shared so neither module imports the other.
 */
export const GENERATE_REEL_CANDIDATES_JOB = {
  queue: QUEUES.REEL_CANDIDATES,
  name: 'generate',
} as const;

export interface ReelCandidatesJobPayload {
  churchId: string;
  sermonId: string;
  /** The sermon's processing run; jobs from an older run are ignored. */
  attempt: number;
  /** Set for a user-requested regeneration, which replaces existing candidates. */
  requestId?: string;
}

export const reelCandidatesJobId = (
  payload: ReelCandidatesJobPayload,
): string =>
  `reel-candidates:${payload.sermonId}:${payload.attempt}${payload.requestId ? `:${payload.requestId}` : ''}`;
