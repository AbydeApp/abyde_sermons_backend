export const CONTENT_TYPES = [
  'DEVOTIONAL',
  'SOCIAL_POST',
  'PRAYER',
  'BIBLE_STUDY',
  'EMAIL',
  'WHATSAPP',
  'QUOTE',
  'VIDEO_IDEA',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHED',
  'FAILED',
  'ARCHIVED',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export type ContentVersionSource = 'AI_GENERATED' | 'AI_REWRITE' | 'USER_EDIT';

export const REWRITE_ACTIONS = [
  'SHORTEN',
  'EXPAND',
  'WARMER',
  'CONVERSATIONAL',
  'ALTERNATIVE',
] as const;
export type RewriteAction = (typeof REWRITE_ACTIONS)[number];

export type JobStatus =
  'QUEUED' | 'PROCESSING' | 'RETRYING' | 'COMPLETED' | 'FAILED';

/** Evidence trail from generated content back to the sermon. */
export interface SourceMetadata {
  sermonId: string;
  transcriptSegmentIds: string[];
  scriptureReferenceIds: string[];
  startTimeMs: number | null;
  endTimeMs: number | null;
  /** True only when the body is an exact transcript extract (pastor's own words). */
  verbatim: boolean;
}

export interface AIAttribution {
  provider: string;
  model: string;
}
