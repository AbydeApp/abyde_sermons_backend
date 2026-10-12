import { QUEUES } from '../../../shared/application/ports/queue.port.js';

export interface ReelRenderJobPayload {
  churchId: string;
  reelId: string;
  /** Jobs from an older render request stop on their own. */
  renderAttempt: number;
}

export const RENDER_REEL_JOB = {
  queue: QUEUES.REEL_RENDER,
  name: 'render',
} as const;

export const RECOVER_REELS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'recover-stuck-reels',
} as const;

export const reelRenderJobId = (payload: ReelRenderJobPayload): string =>
  `reel-render:${payload.reelId}:${payload.renderAttempt}`;
