export const QUEUE = Symbol('QUEUE');

export const QUEUES = {
  SERMON_PROCESSING: 'sermon-processing',
  TRANSCRIPTION: 'transcription',
  SERMON_ANALYSIS: 'sermon-analysis',
  EMBEDDINGS: 'embeddings',
  CONTENT_GENERATION: 'content-generation',
  PUBLISHING: 'publishing',
  EMAIL: 'email',
  MAINTENANCE: 'maintenance',
  BRAND_RENDER: 'brand-render',
  VIDEO_RENDER: 'video-render',
  SOCIAL_PUBLISH: 'social-publish',
  SOCIAL_STATUS: 'social-status',
  SOCIAL_METRICS: 'social-metrics',
  TOKEN_MAINTENANCE: 'token-maintenance',
  REEL_CANDIDATES: 'reel-candidates',
  REEL_RENDER: 'reel-render',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EnqueueOptions {
  /** Deduplicates: a job with the same id is not added twice while it exists. */
  jobId?: string;
  delayMs?: number;
  /** Lower runs sooner (1 = highest). Omitted jobs run in arrival order after prioritised ones. */
  priority?: number;
}

export interface QueuePort {
  enqueue<T extends object>(
    queue: QueueName,
    jobName: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<void>;
}
