import { z } from 'zod';
import { PermanentJobError } from '../../shared/application/jobs.js';
import { InvalidModelOutputError } from '../../shared/application/ports/language-model.port.js';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { DomainError, validationError } from '../../shared/domain/domain-error.js';
import { pageQuery } from '../../shared/infrastructure/http/pagination.js';
import type { MediaAsset } from '../brand/helper.js';

// ───────────────────────── Content types ─────────────────────────

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

// ───────────────────────── Content item ─────────────────────────

export interface ContentVersionRecord {
  version: number;
  title: string;
  body: string;
  scripture: string | null;
  source: ContentVersionSource;
  aiProvider: string | null;
  aiModel: string | null;
  createdAt: Date;
}

export interface ContentItemProps {
  id: string;
  churchId: string;
  sermonId: string;
  generationJobId: string | null;
  type: ContentType;
  position: number;
  title: string;
  body: string;
  scripture: string | null;
  platform: string | null;
  status: ContentStatus;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  sourceMetadata: SourceMetadata;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPatch {
  title?: string;
  body?: string;
  scripture?: string | null;
}

const contentLocked = () =>
  new DomainError(
    'UNPROCESSABLE',
    'CONTENT_LOCKED',
    'Published or archived content cannot be changed.',
  );

/**
 * Content lifecycle: DRAFT → APPROVED → SCHEDULED → PUBLISHED (or FAILED).
 * Every change to title/body creates a new version; history is never rewritten.
 */
export class ContentItem {
  private readonly newVersions: ContentVersionRecord[] = [];

  private constructor(private props: ContentItemProps) {}

  static generate(input: {
    id: string;
    churchId: string;
    sermonId: string;
    generationJobId: string | null;
    type: ContentType;
    position: number;
    title: string;
    body: string;
    scripture: string | null;
    sourceMetadata: SourceMetadata;
    ai: AIAttribution;
    now: Date;
  }): ContentItem {
    const item = new ContentItem({
      id: input.id,
      churchId: input.churchId,
      sermonId: input.sermonId,
      generationJobId: input.generationJobId,
      type: input.type,
      position: input.position,
      title: validTitle(input.title),
      body: validBody(input.body),
      scripture: input.scripture,
      platform: null,
      status: 'DRAFT',
      scheduledAt: null,
      publishedAt: null,
      sourceMetadata: input.sourceMetadata,
      currentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
    item.recordVersion('AI_GENERATED', input.ai, input.now);
    return item;
  }

  static restore(props: ContentItemProps): ContentItem {
    return new ContentItem({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get churchId(): string {
    return this.props.churchId;
  }
  get sermonId(): string {
    return this.props.sermonId;
  }
  get type(): ContentType {
    return this.props.type;
  }
  get status(): ContentStatus {
    return this.props.status;
  }
  get position(): number {
    return this.props.position;
  }
  get title(): string {
    return this.props.title;
  }
  get body(): string {
    return this.props.body;
  }
  get scripture(): string | null {
    return this.props.scripture;
  }
  get sourceMetadata(): SourceMetadata {
    return this.props.sourceMetadata;
  }

  snapshot(): Readonly<ContentItemProps> {
    return { ...this.props };
  }

  /** Versions created since load; the repository appends them. */
  pendingVersions(): readonly ContentVersionRecord[] {
    return this.newVersions;
  }

  /**
   * User edit. Approved/scheduled/failed content returns to DRAFT and must be re-approved.
   * Returns true when the caller must remove the item's calendar entry.
   */
  edit(patch: ContentPatch, now: Date): { unschedule: boolean } {
    return this.revise(patch, 'USER_EDIT', null, now);
  }

  /** AI rewrite/regeneration: persists immediately as the new current version. */
  applyAIRevision(
    content: Required<ContentPatch>,
    source: 'AI_REWRITE' | 'AI_GENERATED',
    ai: AIAttribution,
    now: Date,
    sourceMetadata?: SourceMetadata,
  ): { unschedule: boolean } {
    const result = this.revise(content, source, ai, now);
    if (sourceMetadata) this.props.sourceMetadata = sourceMetadata;
    return result;
  }

  /** Restoring copies an old version forward as a new USER_EDIT version. */
  restoreVersion(
    version: ContentVersionRecord,
    now: Date,
  ): { unschedule: boolean } {
    return this.revise(
      {
        title: version.title,
        body: version.body,
        scripture: version.scripture,
      },
      'USER_EDIT',
      null,
      now,
    );
  }

  /**
   * Idempotent. Re-approving content whose publish failed clears its schedule, so the caller
   * must remove the stale calendar entry and the item reappears as "ready to schedule".
   */
  approve(now: Date): { unschedule: boolean } {
    this.assertMutable();
    if (this.props.status === 'APPROVED' || this.props.status === 'SCHEDULED')
      return { unschedule: false };
    const unschedule = this.props.status === 'FAILED';
    if (unschedule) this.props.scheduledAt = null;
    this.props.status = 'APPROVED';
    this.props.updatedAt = now;
    return { unschedule };
  }

  schedule(at: Date, now: Date): void {
    if (this.props.status !== 'APPROVED' && this.props.status !== 'SCHEDULED') {
      throw new DomainError(
        'UNPROCESSABLE',
        'CONTENT_NOT_APPROVED',
        'Approve this content before scheduling it.',
      );
    }
    this.props.status = 'SCHEDULED';
    this.props.scheduledAt = at;
    this.props.updatedAt = now;
  }

  unschedule(now: Date): void {
    if (this.props.status === 'SCHEDULED' || this.props.status === 'FAILED')
      this.props.status = 'APPROVED';
    this.props.scheduledAt = null;
    this.props.updatedAt = now;
  }

  markPublished(at: Date): void {
    this.props.status = 'PUBLISHED';
    this.props.publishedAt = at;
    this.props.updatedAt = at;
  }

  markPublishFailed(now: Date): void {
    this.props.status = 'FAILED';
    this.props.updatedAt = now;
  }

  private revise(
    patch: ContentPatch,
    source: ContentVersionSource,
    ai: AIAttribution | null,
    now: Date,
  ): { unschedule: boolean } {
    this.assertMutable();
    if (patch.title !== undefined) this.props.title = validTitle(patch.title);
    if (patch.body !== undefined) {
      const body = validBody(patch.body);
      // Once the words change they are no longer the pastor's exact words. (Regeneration of a
      // quote supplies fresh, re-verified source metadata after this.)
      if (body !== this.props.body && this.props.sourceMetadata.verbatim) {
        this.props.sourceMetadata = {
          ...this.props.sourceMetadata,
          verbatim: false,
        };
      }
      this.props.body = body;
    }
    if (patch.scripture !== undefined)
      this.props.scripture = patch.scripture?.trim() || null;
    // Any calendar entry belongs to the approved wording; it never survives a change.
    const unschedule = this.props.status !== 'DRAFT';
    if (this.props.status !== 'DRAFT') {
      this.props.status = 'DRAFT';
      this.props.scheduledAt = null;
    }
    this.props.currentVersion += 1;
    this.recordVersion(source, ai, now);
    return { unschedule };
  }

  private recordVersion(
    source: ContentVersionSource,
    ai: AIAttribution | null,
    now: Date,
  ): void {
    this.props.updatedAt = now;
    this.newVersions.push({
      version: this.props.currentVersion,
      title: this.props.title,
      body: this.props.body,
      scripture: this.props.scripture,
      source,
      aiProvider: source === 'USER_EDIT' ? null : (ai?.provider ?? null),
      aiModel: source === 'USER_EDIT' ? null : (ai?.model ?? null),
      createdAt: now,
    });
  }

  /** Throws when the content can no longer be changed (published or archived). */
  assertEditable(): void {
    this.assertMutable();
  }

  private assertMutable(): void {
    if (this.props.status === 'PUBLISHED' || this.props.status === 'ARCHIVED')
      throw contentLocked();
  }
}

function validTitle(title: string): string {
  const value = title.trim();
  if (!value) throw validationError('title', 'Title is required');
  if (value.length > 200)
    throw validationError('title', 'Title must be at most 200 characters');
  return value;
}

function validBody(body: string): string {
  const value = body.trim();
  if (!value) throw validationError('body', 'Content cannot be empty');
  if (value.length > 20_000)
    throw validationError('body', 'Content is too long');
  return value;
}

// ───────────────────────── Calendar item ─────────────────────────

export type CalendarItemStatus =
  'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

export interface CalendarItemProps {
  id: string;
  churchId: string;
  contentItemId: string;
  scheduledAt: Date;
  status: CalendarItemStatus;
}

export const pastDate = () =>
  new DomainError(
    'UNPROCESSABLE',
    'PAST_DATE',
    'Choose a time in the future.',
    { scheduledAt: ['Choose a time in the future'] },
  );

export class CalendarItem {
  private constructor(private props: CalendarItemProps) {}

  static schedule(input: {
    id: string;
    churchId: string;
    contentItemId: string;
    scheduledAt: Date;
    now: Date;
  }): CalendarItem {
    const { now, ...props } = input;
    if (props.scheduledAt <= now) throw pastDate();
    return new CalendarItem({ ...props, status: 'SCHEDULED' });
  }

  static restore(props: CalendarItemProps): CalendarItem {
    return new CalendarItem({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get contentItemId(): string {
    return this.props.contentItemId;
  }
  get scheduledAt(): Date {
    return this.props.scheduledAt;
  }
  get status(): CalendarItemStatus {
    return this.props.status;
  }

  snapshot(): Readonly<CalendarItemProps> {
    return { ...this.props };
  }

  reschedule(at: Date, now: Date): void {
    this.assertNotPublishing();
    if (at <= now) throw pastDate();
    this.props.scheduledAt = at;
    this.props.status = 'SCHEDULED';
  }

  assertNotPublishing(): void {
    if (this.props.status === 'PUBLISHING') {
      throw new DomainError(
        'CONFLICT',
        'CONTENT_PUBLISHING',
        'This content is being published right now.',
      );
    }
  }
}

// ───────────────────────── Generation groups ─────────────────────────

export interface GenerationJobRecord {
  id: string;
  groupId: string;
  churchId: string;
  sermonId: string;
  contentType: ContentType;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
}

export interface GenerationGroupRecord {
  id: string;
  churchId: string;
  sermonId: string;
  createdAt: Date;
  jobs: GenerationJobRecord[];
}

export const isTerminal = (status: JobStatus): boolean =>
  status === 'COMPLETED' || status === 'FAILED';

export const isGroupDone = (group: GenerationGroupRecord): boolean =>
  group.jobs.every((job) => isTerminal(job.status));

/**
 * Decides how a generate-week request maps onto the latest group, so "Retry failed" never duplicates work.
 * Reuse the latest group when it still has unfinished or failed work for the requested types; in it,
 * FAILED types are re-queued, in-flight and COMPLETED types are left alone, unseen types are added.
 * Otherwise (no group, or every requested type already completed) start a fresh group.
 */
export function planGeneration(
  latest: GenerationGroupRecord | null,
  requested: ContentType[],
): { reuse: boolean; requeue: ContentType[]; add: ContentType[] } {
  const types = [...new Set(requested)];
  if (latest) {
    const byType = new Map(latest.jobs.map((job) => [job.contentType, job]));
    const reusable = types.some((type) => {
      const job = byType.get(type);
      return job !== undefined && job.status !== 'COMPLETED';
    });
    if (reusable) {
      return {
        reuse: true,
        requeue: types.filter((type) => byType.get(type)?.status === 'FAILED'),
        add: types.filter((type) => !byType.has(type)),
      };
    }
  }
  return { reuse: false, requeue: [], add: types };
}

// ───────────────────────── Prompt specs ─────────────────────────

export interface ContentSpec {
  count: number;
  label: string;
  instructions: string;
  tone: 'devotional' | 'social';
  maxBodyChars: number;
}

/** What each content type produces (B16–B20). Counts follow the "Generate My Week" targets. */
export const CONTENT_SPECS: Record<ContentType, ContentSpec> = {
  DEVOTIONAL: {
    count: 7,
    label: 'daily devotionals (Day 1 to Day 7)',
    instructions:
      'Write one devotional per day for 7 days, each 200–350 words. Each builds on one idea from the sermon, opens with a scripture the preacher used, reflects on it, and ends with a one-line prayer and a practical step. Title format: "Day N: <title>".',
    tone: 'devotional',
    maxBodyChars: 4000,
  },
  SOCIAL_POST: {
    count: 7,
    label: 'social media posts',
    instructions:
      'Write 7 social posts (Facebook/Instagram) of 40–120 words each, one per day of the week. Vary the format: reflection, question, scripture highlight, application, invitation. End each with 2–4 relevant hashtags. The title is a short internal label.',
    tone: 'social',
    maxBodyChars: 1200,
  },
  PRAYER: {
    count: 5,
    label: 'prayer points',
    instructions:
      "Write 5 prayers or prayer points (60–150 words each) the congregation can pray this week, rooted in the sermon's message.",
    tone: 'devotional',
    maxBodyChars: 1500,
  },
  BIBLE_STUDY: {
    count: 1,
    label: 'small-group Bible study guide',
    instructions:
      'Write one small-group study guide with these sections: Overview (2–3 sentences), Read (the passages the sermon used), Discuss (6–8 open questions), Apply (2–3 practical challenges), Pray (a closing prayer). Use simple Markdown headings.',
    tone: 'devotional',
    maxBodyChars: 8000,
  },
  EMAIL: {
    count: 1,
    label: 'email newsletter',
    instructions:
      "Write one church email newsletter (250–450 words) recapping Sunday's message for people who were there and people who missed it, with a clear encouragement for the week. The title is the email subject line.",
    tone: 'devotional',
    maxBodyChars: 6000,
  },
  WHATSAPP: {
    count: 5,
    label: 'WhatsApp broadcast messages',
    instructions:
      'Write 5 short WhatsApp messages (30–90 words) for the church broadcast list, one for each weekday. Plain text, friendly, at most two emoji, no hashtags.',
    tone: 'social',
    maxBodyChars: 900,
  },
  QUOTE: {
    count: 6,
    label: 'quotable lines',
    instructions:
      'Select up to 6 memorable sentences the preacher actually said. Copy each word-for-word from its numbered segment; do not edit, merge or paraphrase. The title is a 2–5 word label.',
    tone: 'social',
    maxBodyChars: 500,
  },
  VIDEO_IDEA: {
    count: 4,
    label: 'short-form video ideas',
    instructions:
      'Suggest 4 short-form video (Reels/Shorts/TikTok, 30–60s) ideas drawn from moments in the sermon. For each: a hook line, which segment to clip, a 3-step outline, and an on-screen caption. Reference the segments you would clip.',
    tone: 'social',
    maxBodyChars: 2000,
  },
};

export const REWRITE_INSTRUCTIONS: Record<RewriteAction, string> = {
  SHORTEN:
    'Make it noticeably shorter (about half the length) while keeping the core message.',
  EXPAND:
    'Expand it with more depth and one more practical example, keeping the same message.',
  WARMER: 'Make the tone warmer, more pastoral and encouraging.',
  CONVERSATIONAL:
    'Make it more conversational and easy to read, like talking to a friend.',
  ALTERNATIVE:
    'Write a fresh alternative version with a different angle on the same idea.',
};

// ───────────────────────── Service constants ─────────────────────────

export const contentLockKey = (id: string) => `content:${id}`;
export const generationLockKey = (sermonId: string) => `generation:${sermonId}`;
export const aiBusyKey = (id: string) => `content-ai:${id}`;
export const AI_BUSY_TTL_SECONDS = 180;
export const SIBLING_PAGE_SIZE = 100;
export const MAX_CALENDAR_RANGE_MS = 400 * 24 * 3600 * 1000;
export const VISUAL_URL_TTL_SECONDS = 15 * 60;
export const VISUAL_ASSET_LIMIT = 500;

/** Generation retries finish within a few minutes; half an hour without progress means the job was lost. */
export const STUCK_GENERATION_AFTER_MS = 30 * 60 * 1000;
export const RECOVER_GENERATIONS_EVERY_MS = 10 * 60 * 1000;
export const STUCK_GENERATION_MESSAGE = 'Generation was interrupted. Please retry.';

export interface GenerationJobPayload {
  churchId: string;
  sermonId: string;
  groupId: string;
  jobId: string;
  contentType: ContentType;
}

export const GENERATE_CONTENT_JOB = { queue: QUEUES.CONTENT_GENERATION, name: 'generate' } as const;
export const RECOVER_STUCK_GENERATIONS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'recover-stuck-generations',
} as const;

// ───────────────────────── Errors ─────────────────────────

export const contentBusy = () =>
  new DomainError(
    'CONFLICT',
    'CONTENT_BUSY',
    'This content is already being rewritten. Please wait a moment.',
  );

export const noAlternative = () =>
  new DomainError(
    'UNPROCESSABLE',
    'NO_ALTERNATIVE',
    'No other exact quotes were found in this sermon.',
  );

export const generationFailed = () =>
  new DomainError(
    'UNAVAILABLE',
    'GENERATION_FAILED',
    'We could not regenerate this content. Please try again.',
  );

export const userMessageFor = (error: unknown): string => {
  if (error instanceof PermanentJobError && error.userMessage) return error.userMessage;
  if (error instanceof InvalidModelOutputError) return 'The model returned invalid output.';
  return 'Generation failed. Please retry.';
};

// ───────────────────────── Views ─────────────────────────

export interface VisualAsset {
  id: string;
  url: string;
  width: number;
  height: number;
  kind: 'image' | 'video';
}

/** Render state of a content item's latest visual; null when nothing was ever rendered. */
export interface ContentVisual {
  status: 'RENDERING' | 'READY' | 'FAILED';
  assets: VisualAsset[];
  thumbnailUrl: string | null;
  errorMessage: string | null;
}

export interface ContentView {
  id: string;
  type: ContentType;
  title: string;
  body: string;
  status: ContentStatus;
  sermonId: string;
  sermonTitle: string;
  scripture: string | null;
  calendarItemId: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  currentVersion: number;
  updatedAt: Date;
  source: {
    sermonId: string;
    sermonTitle: string;
    segments: Array<{ id: string; startTimeMs: number; endTimeMs: number; text: string }>;
    scriptures: string[];
    verbatim: boolean;
  };
  visual: ContentVisual | null;
}

/** The assets of a content item's latest render (they share a render group), in slide order. */
export function latestRender(assets: MediaAsset[]): MediaAsset[] {
  const latest = assets[0];
  if (!latest?.renderGroupId) return [];
  return assets
    .filter((asset) => asset.renderGroupId === latest.renderGroupId)
    .sort((a, b) => a.position - b.position);
}

/** Render state from one render group; `urls` holds signed URLs for the assets that are ready. */
export function buildVisual(
  group: MediaAsset[],
  urls: ReadonlyMap<string, string>,
): ContentVisual | null {
  if (group.length === 0) return null;
  const failed = group.find((asset) => asset.status === 'FAILED');
  const pending = group.some((asset) => asset.status === 'PENDING');
  const ready = (kinds: MediaAsset['kind'][]) =>
    group.filter((asset) => asset.status === 'READY' && kinds.includes(asset.kind));
  const thumbnail = ready(['THUMBNAIL'])[0];
  return {
    status: pending ? 'RENDERING' : failed ? 'FAILED' : 'READY',
    assets: ready(['IMAGE', 'CAROUSEL_SLIDE', 'VIDEO']).map((asset) => ({
      id: asset.id,
      url: urls.get(asset.id) ?? '',
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      kind: asset.kind === 'VIDEO' ? 'video' : 'image',
    })),
    thumbnailUrl: thumbnail ? (urls.get(thumbnail.id) ?? null) : null,
    errorMessage: failed?.errorMessage ?? null,
  };
}

export interface CalendarRow {
  id: string;
  contentItemId: string;
  scheduledAt: Date;
  status: CalendarItemStatus;
  content: {
    id: string;
    type: ContentType;
    title: string;
    status: ContentStatus;
    sermonId: string;
    sermonTitle: string;
  };
}

export const toContentResponse = (view: ContentView) => ({
  ...view,
  scheduledAt: view.scheduledAt?.toISOString() ?? null,
  publishedAt: view.publishedAt?.toISOString() ?? null,
  updatedAt: view.updatedAt.toISOString(),
});

export const toVersionResponse = (version: ContentVersionRecord) => ({
  version: version.version,
  title: version.title,
  body: version.body,
  source: version.source,
  aiProvider: version.aiProvider,
  aiModel: version.aiModel,
  createdAt: version.createdAt.toISOString(),
});

export const toGenerationGroupResponse = (group: GenerationGroupRecord) => ({
  id: group.id,
  sermonId: group.sermonId,
  jobs: group.jobs.map((job) => ({
    contentType: job.contentType,
    status: job.status,
    errorMessage: job.errorMessage,
  })),
  done: isGroupDone(group),
});

export const toCalendarResponse = (row: CalendarRow) => ({
  ...row,
  scheduledAt: row.scheduledAt.toISOString(),
});

// ───────────────────────── Request schemas ─────────────────────────

const instant = (message: string) =>
  z
    .string({ error: message })
    .refine((value) => !Number.isNaN(Date.parse(value)), message)
    .transform((value) => new Date(value));

export const ListQuery = z.object({
  status: z.enum(CONTENT_STATUSES, { error: 'Unknown status' }).optional(),
  type: z.enum(CONTENT_TYPES, { error: 'Unknown content type' }).optional(),
  sermonId: z.string().uuid('Invalid sermon id').optional(),
  generationId: z.string().uuid('Invalid generation id').optional(),
  q: z.string().trim().max(200).optional(),
  scheduled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  ...pageQuery,
});

export const PatchBody = z
  .object({
    title: z.string().max(200),
    body: z.string().max(20_000),
    scripture: z.string().max(80).nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');

export const RewriteBody = z.object({
  action: z.enum(REWRITE_ACTIONS, { error: 'Unknown rewrite action' }),
});

export const GenerateWeekBody = z.object({
  contentTypes: z
    .array(z.enum(CONTENT_TYPES, { error: 'Unknown content type' }), {
      error: 'Choose at least one content type',
    })
    .min(1, 'Choose at least one content type')
    .max(CONTENT_TYPES.length),
});

export const RangeQuery = z.object({
  from: instant('"from" must be an ISO date-time'),
  to: instant('"to" must be an ISO date-time'),
});
export const ScheduleBody = z.object({
  contentItemId: z.string({ error: 'Content is required' }).uuid('Invalid content id'),
  scheduledAt: instant('Choose a date and time'),
});
export const RescheduleBody = z.object({ scheduledAt: instant('Choose a date and time') });
