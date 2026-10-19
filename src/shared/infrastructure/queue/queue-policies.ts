import type { QueueName } from '../../application/ports/queue.port.js';

export interface QueuePolicy {
  attempts: number;
  backoffMs: number;
  /**
   * Hard limit for one attempt. When it passes, the job's abort signal fires, in-flight I/O stops
   * and the attempt fails (and is retried). Every limit fits inside the worker's shutdown grace
   * period (`WORKER_SHUTDOWN_GRACE_MS`, default 30 minutes).
   */
  timeoutMs: number;
  /** Remove payloads as soon as the job succeeds (e.g. emails carrying single-use links). */
  discardOnComplete?: boolean;
  /** Caps jobs in flight per worker process below WORKER_CONCURRENCY (CPU/disk-heavy queues). */
  maxConcurrency?: number;
}

const MINUTE = 60_000;

/** Retry policy per queue: exponential backoff starting at `backoffMs`. */
export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  'sermon-processing': { attempts: 3, backoffMs: 5_000, timeoutMs: 1 * MINUTE },
  // Longest job: download, ffmpeg and sequential chunk transcription of a multi-hour sermon.
  transcription: { attempts: 4, backoffMs: 30_000, timeoutMs: 25 * MINUTE },
  'sermon-analysis': { attempts: 4, backoffMs: 15_000, timeoutMs: 5 * MINUTE },
  embeddings: { attempts: 5, backoffMs: 10_000, timeoutMs: 10 * MINUTE },
  'content-generation': {
    attempts: 4,
    backoffMs: 15_000,
    timeoutMs: 5 * MINUTE,
  },
  publishing: { attempts: 5, backoffMs: 60_000, timeoutMs: 3 * MINUTE },
  email: {
    attempts: 6,
    backoffMs: 30_000,
    timeoutMs: 1 * MINUTE,
    discardOnComplete: true,
  },
  maintenance: { attempts: 1, backoffMs: 0, timeoutMs: 5 * MINUTE },
  'brand-render': {
    attempts: 3,
    backoffMs: 10_000,
    timeoutMs: 3 * MINUTE,
    maxConcurrency: 2,
  },
  // One ffmpeg encode per worker process: an encode uses every core it is given.
  'video-render': {
    attempts: 2,
    backoffMs: 60_000,
    timeoutMs: 25 * MINUTE,
    maxConcurrency: 1,
  },
  // Covers a chunked video upload to a provider (YouTube, X, LinkedIn) inside one attempt.
  'social-publish': { attempts: 5, backoffMs: 60_000, timeoutMs: 20 * MINUTE },
  // Status polls re-enqueue themselves with a delay; the retry policy only covers transient errors.
  'social-status': { attempts: 3, backoffMs: 30_000, timeoutMs: 2 * MINUTE },
  'social-metrics': { attempts: 1, backoffMs: 0, timeoutMs: 5 * MINUTE },
  'token-maintenance': { attempts: 1, backoffMs: 0, timeoutMs: 5 * MINUTE },
};

export const LONGEST_JOB_TIMEOUT_MS = Math.max(
  ...Object.values(QUEUE_POLICIES).map((policy) => policy.timeoutMs),
);
