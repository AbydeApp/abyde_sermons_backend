import {
  QUEUES,
  type QueueName,
} from '../../../shared/application/ports/queue.port.js';
import type { PipelinePhase, ProcessingStage } from '../domain/processing.js';

export interface SermonJobPayload {
  churchId: string;
  sermonId: string;
  /** Processing run number; jobs from superseded runs are ignored. */
  attempt: number;
  fromStage?: ProcessingStage;
}

export const SERMON_JOBS = {
  START: { queue: QUEUES.SERMON_PROCESSING, name: 'start' },
  TRANSCRIBE: { queue: QUEUES.TRANSCRIPTION, name: 'transcribe' },
  ANALYZE: { queue: QUEUES.SERMON_ANALYSIS, name: 'analyze' },
  INDEX: { queue: QUEUES.EMBEDDINGS, name: 'index' },
} as const satisfies Record<string, { queue: QueueName; name: string }>;

export const PHASE_JOBS: Record<
  PipelinePhase,
  { queue: QueueName; name: string }
> = {
  TRANSCRIPTION: SERMON_JOBS.TRANSCRIBE,
  ANALYSIS: SERMON_JOBS.ANALYZE,
  INDEXING: SERMON_JOBS.INDEX,
};

/** Deterministic job ids make enqueueing idempotent per sermon, run and phase. */
export const sermonJobId = (payload: SermonJobPayload, phase: string): string =>
  `sermon:${payload.sermonId}:${payload.attempt}:${phase}`;
