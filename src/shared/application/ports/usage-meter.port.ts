export const USAGE_METER = Symbol('USAGE_METER');

export type UsageUnit =
  | 'SERMON_PROCESSED'
  | 'CONTENT_GENERATED'
  | 'TRANSCRIPTION_MINUTE'
  | 'TEXT_GENERATION'
  | 'EMBEDDING'
  | 'IMAGE_GENERATION'
  | 'VIDEO_GENERATION'
  | 'STORAGE_BYTES'
  /** One completed Reel render (re-renders count again). */
  | 'REEL_RENDERED'
  /** Wall-clock seconds a worker spent rendering. */
  | 'RENDER_SECOND'
  /** One post made public on one platform. */
  | 'SOCIAL_PUBLICATION';

export interface UsageRecord {
  churchId: string;
  unit: UsageUnit;
  quantity: number;
  sermonId?: string;
  /** Same key recorded twice counts once (job retries stay idempotent). */
  dedupeKey?: string;
}

export interface UsageMeterPort {
  record(usage: UsageRecord): Promise<void>;
}

export const AI_USAGE_RECORDER = Symbol('AI_USAGE_RECORDER');

export interface AIUsageEntry {
  churchId?: string;
  sermonId?: string;
  operation: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  status: 'SUCCEEDED' | 'FAILED';
}

export interface AIUsageRecorderPort {
  record(entry: AIUsageEntry): Promise<void>;
  /** Maintenance: removes cost-log rows created before `cutoff`; returns how many. */
  deleteBefore(cutoff: Date): Promise<number>;
}
