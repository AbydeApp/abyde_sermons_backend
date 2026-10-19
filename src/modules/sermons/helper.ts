import { z } from 'zod';
import { DomainError, notFound, validationError } from '../../shared/domain/domain-error.js';
import { QUEUES, type QueueName } from '../../shared/application/ports/queue.port.js';
import { pageQuery } from '../../shared/infrastructure/http/pagination.js';
import type { MediaKind } from '../uploads/helper.js';

// ───────────────────────── Processing states ─────────────────────────

export type SermonStatus =
  | 'UPLOADING'
  | 'UPLOADED'
  | 'QUEUED'
  | 'TRANSCRIBING'
  | 'ANALYZING'
  | 'INDEXING'
  | 'READY'
  | 'FAILED'
  | 'ARCHIVED';

/** The seven steps the web app renders, in order. */
export const PROCESSING_STAGES = [
  'UPLOAD',
  'MEDIA',
  'TRANSCRIBE',
  'UNDERSTAND',
  'SCRIPTURES',
  'INTELLIGENCE',
  'INDEX',
] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const PROCESSING_STATUSES: SermonStatus[] = [
  'UPLOADING',
  'UPLOADED',
  'QUEUED',
  'TRANSCRIBING',
  'ANALYZING',
  'INDEXING',
];

const STATUS_FOR_STAGE: Record<ProcessingStage, SermonStatus> = {
  UPLOAD: 'QUEUED',
  MEDIA: 'TRANSCRIBING',
  TRANSCRIBE: 'TRANSCRIBING',
  UNDERSTAND: 'ANALYZING',
  SCRIPTURES: 'ANALYZING',
  INTELLIGENCE: 'ANALYZING',
  INDEX: 'INDEXING',
};

export const statusForStage = (stage: ProcessingStage): SermonStatus =>
  STATUS_FOR_STAGE[stage];

/** Pipeline phases map onto queues: each phase is retried independently. */
export type PipelinePhase = 'TRANSCRIPTION' | 'ANALYSIS' | 'INDEXING';

export function phaseForStage(stage: ProcessingStage): PipelinePhase {
  if (stage === 'UPLOAD' || stage === 'MEDIA' || stage === 'TRANSCRIBE')
    return 'TRANSCRIPTION';
  if (stage === 'INDEX') return 'INDEXING';
  return 'ANALYSIS';
}

/** User-safe failure messages per stage (provider errors are never shown). */
export const STAGE_FAILURE_MESSAGES: Record<ProcessingStage, string> = {
  UPLOAD: 'We could not start processing this upload.',
  MEDIA:
    'We could not read this file. Check that it plays correctly and try again.',
  TRANSCRIBE: 'We could not transcribe this sermon. Please try again.',
  UNDERSTAND: 'We could not analyse this sermon. Please try again.',
  SCRIPTURES: 'We could not check the scripture references. Please try again.',
  INTELLIGENCE: 'We could not build the sermon summary. Please try again.',
  INDEX: 'We could not prepare this sermon for search. Please try again.',
};

export type SermonSourceType = 'MEDIA' | 'DOCUMENT' | 'TEXT';

// ───────────────────────── Transcript segmentation ─────────────────────────

/** One spoken word with its position in the sermon (milliseconds from the start). */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Raw transcription output: timed fragments from speech-to-text, or untimed document text. */
export interface TranscriptFragment {
  text: string;
  startMs?: number;
  endMs?: number;
  /** Word-level timings when the provider returns them. */
  words?: TranscriptWord[];
}

export interface SegmentDraft {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  /** Present only when every fragment in the segment came with word timings. */
  words?: TranscriptWord[];
}

type TimedFragment = Required<Omit<TranscriptFragment, 'words'>> &
  Pick<TranscriptFragment, 'words'>;

const TARGET_MIN_MS = 45_000;
const HARD_MAX_MS = 120_000;
const MAX_WORDS = 280;
/** Average preaching pace (~150 words per minute) used to estimate positions in untimed text. */
const MS_PER_WORD = 400;

const SENTENCE_END = /[.!?]["')\]]?$/;

export function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** Splits untimed text into sentence fragments with estimated timestamps. */
function estimateTiming(fragments: TranscriptFragment[]): TimedFragment[] {
  const sentences = fragments
    .flatMap((fragment) =>
      cleanText(fragment.text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/),
    )
    .filter((sentence) => sentence.length > 0);
  let cursor = 0;
  return sentences.map((text) => {
    const startMs = cursor;
    cursor += Math.max(1, wordCount(text)) * MS_PER_WORD;
    return { text, startMs, endMs: cursor };
  });
}

/**
 * Groups fragments into readable, citeable segments (~45–120 s), breaking at sentence boundaries.
 * Segments are the unit of evidence: generated content and search results cite them by id + timestamps.
 */
export function segmentTranscript(
  fragments: TranscriptFragment[],
): SegmentDraft[] {
  const timed = fragments.every(
    (fragment) =>
      fragment.startMs !== undefined && fragment.endMs !== undefined,
  );
  const items: TimedFragment[] = timed
    ? fragments
        .map((fragment) => ({
          text: cleanText(fragment.text),
          startMs: fragment.startMs ?? 0,
          endMs: fragment.endMs ?? 0,
          words: fragment.words
            ?.map((word) => ({ ...word, text: word.text.trim() }))
            .filter(
              (word) => word.text.length > 0 && word.endMs >= word.startMs,
            ),
        }))
        .filter((fragment) => fragment.text.length > 0)
        .sort((a, b) => a.startMs - b.startMs)
    : estimateTiming(fragments);

  const segments: SegmentDraft[] = [];
  let buffer: TimedFragment[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (first && last) {
      // Word timings are kept only when the whole segment has them, so they always cover its text.
      const words = buffer.every((fragment) => fragment.words?.length)
        ? buffer.flatMap((fragment) => fragment.words ?? [])
        : undefined;
      segments.push({
        sequence: segments.length + 1,
        startTimeMs: Math.round(first.startMs),
        endTimeMs: Math.round(Math.max(last.endMs, first.startMs)),
        text: buffer.map((fragment) => fragment.text).join(' '),
        ...(words
          ? {
              words: words.map((word) => ({
                text: word.text,
                startMs: Math.round(word.startMs),
                endMs: Math.round(word.endMs),
              })),
            }
          : {}),
      });
    }
    buffer = [];
  };

  for (const item of items) {
    buffer.push(item);
    const first = buffer[0];
    const duration = first ? item.endMs - first.startMs : 0;
    const words = wordCount(buffer.map((fragment) => fragment.text).join(' '));
    const atSentenceEnd = SENTENCE_END.test(item.text);
    if (
      (duration >= TARGET_MIN_MS && atSentenceEnd) ||
      duration >= HARD_MAX_MS ||
      words >= MAX_WORDS
    )
      flush();
  }
  flush();
  return segments;
}

export const totalWords = (segments: SegmentDraft[]): number =>
  segments.reduce((sum, segment) => sum + wordCount(segment.text), 0);

// ───────────────────────── Sermon intelligence ─────────────────────────

/** Evidence-linked item extracted from a sermon. `sourceSegmentId` (when set) belongs to the same sermon. */
export interface IntelligenceItem {
  id: string;
  text: string;
  sourceSegmentId: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
}

/** Persisted structured representation of a sermon (validated before storage). */
export interface SermonIntelligence {
  title: string;
  summary: string;
  mainTheme: IntelligenceItem;
  secondaryThemes: IntelligenceItem[];
  keyPoints: IntelligenceItem[];
  /** Verbatim pastor quotes only — each verified against its transcript segment. */
  quotes: IntelligenceItem[];
  stories: IntelligenceItem[];
  applications: IntelligenceItem[];
  prayers: IntelligenceItem[];
  questions: IntelligenceItem[];
  audienceTakeaways: IntelligenceItem[];
  /** Verified scripture display strings. */
  scriptures: string[];
}

export interface ScriptureReferenceRecord {
  id: string;
  churchId: string;
  sermonId: string;
  book: string;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
  translation: string | null;
  verified: boolean;
  display: string;
  sourceSegmentId: string | null;
}

export interface TranscriptSegmentRecord {
  id: string;
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  speakerLabel: string | null;
  /** Word-level timings (absolute, ms) when transcription provided them. */
  words?: TranscriptWord[];
}

// ───────────────────────── Sermon ─────────────────────────

export interface SermonProps {
  id: string;
  churchId: string;
  title: string;
  speaker: string;
  sermonDate: Date;
  series: string | null;
  mainScripture: string | null;
  tags: string[];
  status: SermonStatus;
  processingStage: ProcessingStage | null;
  failedStage: ProcessingStage | null;
  errorMessage: string | null;
  canRetry: boolean;
  sourceType: SermonSourceType;
  summary: string | null;
  mainTheme: string | null;
  themes: string[];
  scriptures: string[];
  durationMs: number | null;
  processingAttempts: number;
  readyAt: Date | null;
  createdAt: Date;
}

export interface SermonDetails {
  title?: string;
  speaker?: string;
  sermonDate?: Date;
  series?: string | null;
  mainScripture?: string | null;
  tags?: string[];
}

const MAX_TAGS = 20;

export class Sermon {
  private constructor(private props: SermonProps) {}

  static create(input: {
    id: string;
    churchId: string;
    sourceType: SermonSourceType;
    details: Required<Pick<SermonDetails, 'title' | 'speaker' | 'sermonDate'>> &
      SermonDetails;
    now: Date;
  }): Sermon {
    const sermon = new Sermon({
      id: input.id,
      churchId: input.churchId,
      title: '',
      speaker: '',
      sermonDate: input.details.sermonDate,
      series: null,
      mainScripture: null,
      tags: [],
      status: 'QUEUED',
      processingStage: 'UPLOAD',
      failedStage: null,
      errorMessage: null,
      canRetry: false,
      sourceType: input.sourceType,
      summary: null,
      mainTheme: null,
      themes: [],
      scriptures: [],
      durationMs: null,
      processingAttempts: 1,
      readyAt: null,
      createdAt: input.now,
    });
    sermon.updateDetails(input.details);
    return sermon;
  }

  static restore(props: SermonProps): Sermon {
    return new Sermon({
      ...props,
      tags: [...props.tags],
      themes: [...props.themes],
      scriptures: [...props.scriptures],
    });
  }

  get id(): string {
    return this.props.id;
  }
  get churchId(): string {
    return this.props.churchId;
  }
  get status(): SermonStatus {
    return this.props.status;
  }
  get processingStage(): ProcessingStage | null {
    return this.props.processingStage;
  }
  get processingAttempts(): number {
    return this.props.processingAttempts;
  }
  get sourceType(): SermonSourceType {
    return this.props.sourceType;
  }
  get title(): string {
    return this.props.title;
  }
  get isReady(): boolean {
    return this.props.status === 'READY';
  }

  snapshot(): Readonly<SermonProps> {
    return { ...this.props };
  }

  updateDetails(details: SermonDetails): void {
    const next = { ...this.props };
    if (details.title !== undefined)
      next.title = requireText(
        details.title,
        'title',
        'Title is required',
        200,
      );
    if (details.speaker !== undefined)
      next.speaker = requireText(
        details.speaker,
        'speaker',
        'Speaker is required',
        120,
      );
    if (details.sermonDate !== undefined) {
      if (Number.isNaN(details.sermonDate.getTime()))
        throw validationError('sermonDate', 'Enter a valid date');
      next.sermonDate = details.sermonDate;
    }
    if (details.series !== undefined)
      next.series = optionalText(details.series, 'series', 120);
    if (details.mainScripture !== undefined)
      next.mainScripture = optionalText(
        details.mainScripture,
        'mainScripture',
        120,
      );
    if (details.tags !== undefined) {
      const tags = [
        ...new Set(
          details.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
        ),
      ];
      if (tags.length > MAX_TAGS)
        throw validationError('tags', `At most ${MAX_TAGS} tags`);
      if (tags.some((tag) => tag.length > 40))
        throw validationError('tags', 'Tags must be at most 40 characters');
      next.tags = tags;
    }
    this.props = next;
  }

  /** True when a job for `attempt` belongs to the current processing run (stale retries are ignored). */
  acceptsJobFor(attempt: number): boolean {
    return (
      this.props.processingAttempts === attempt &&
      this.props.status !== 'READY' &&
      this.props.status !== 'FAILED' &&
      this.props.status !== 'ARCHIVED'
    );
  }

  enterStage(stage: ProcessingStage): void {
    if (this.props.status === 'ARCHIVED' || this.props.status === 'READY') {
      throw new DomainError(
        'CONFLICT',
        'INVALID_STATE',
        `Cannot process a ${this.props.status.toLowerCase()} sermon.`,
      );
    }
    this.props.status = statusForStage(stage);
    this.props.processingStage = stage;
    this.props.failedStage = null;
    this.props.errorMessage = null;
    this.props.canRetry = false;
  }

  recordDuration(durationMs: number): void {
    this.props.durationMs = Math.max(0, Math.round(durationMs));
  }

  applyAnalysis(input: {
    summary: string;
    mainTheme: string;
    themes: string[];
    scriptures: string[];
  }): void {
    this.props.summary = input.summary;
    this.props.mainTheme = input.mainTheme;
    this.props.themes = dedupe(input.themes);
    this.props.scriptures = dedupe(input.scriptures);
  }

  markReady(now: Date): void {
    this.props.status = 'READY';
    this.props.processingStage = null;
    this.props.readyAt = now;
  }

  markFailed(
    stage: ProcessingStage,
    errorMessage: string,
    canRetry: boolean,
  ): void {
    this.props.status = 'FAILED';
    this.props.failedStage = stage;
    this.props.processingStage = null;
    this.props.errorMessage = errorMessage;
    this.props.canRetry = canRetry;
  }

  /** Resumes a failed run from the stage that failed; returns that stage. */
  retry(): ProcessingStage {
    if (this.props.status !== 'FAILED' || !this.props.canRetry) {
      throw new DomainError(
        'CONFLICT',
        'CANNOT_RETRY',
        'This sermon cannot be retried.',
      );
    }
    const resumeFrom = this.props.failedStage ?? 'UPLOAD';
    this.props.processingAttempts += 1;
    this.props.status = 'QUEUED';
    this.props.processingStage = resumeFrom;
    this.props.failedStage = null;
    this.props.errorMessage = null;
    this.props.canRetry = false;
    return resumeFrom;
  }
}

function requireText(
  value: string,
  field: string,
  message: string,
  max: number,
): string {
  const text = value.trim();
  if (!text) throw validationError(field, message);
  if (text.length > max)
    throw validationError(field, `Must be at most ${max} characters`);
  return text;
}

function optionalText(
  value: string | null,
  field: string,
  max: number,
): string | null {
  if (value === null) return null;
  const text = value.trim();
  if (text.length > max)
    throw validationError(field, `Must be at most ${max} characters`);
  return text || null;
}

const dedupe = (values: string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

// ───────────────────────── Pipeline jobs ─────────────────────────

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

// ───────────────────────── Prompt context ─────────────────────────

/** Guardrails shared by every sermon-grounded prompt. */
export const GUARDRAILS = [
  'Rules you must follow:',
  '- Use only what is in the provided sermon material. Do not invent events, teachings, or claims.',
  '- Never invent or alter Bible verses. Cite only references that exist; if unsure, omit the reference.',
  '- Never fabricate quotations or attribute your own wording to the pastor.',
  '- Write in plain, warm language suitable for a church audience.',
].join('\n');

const MAX_TRANSCRIPT_CHARS = 180_000;

export const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
};

/**
 * Renders numbered segments for a prompt. Very long transcripts are evenly sampled so the
 * request stays within the model's context budget while still covering the whole sermon.
 */
export function buildTranscriptContext(
  segments: TranscriptSegmentRecord[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const lines = segments.map(
    (segment) =>
      `[${segment.sequence}] (${formatTimestamp(segment.startTimeMs)}) ${segment.text}`,
  );
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return lines.join('\n');
  const keepRatio = maxChars / total;
  const kept: string[] = [];
  let budget = 0;
  lines.forEach((line, index) => {
    budget += keepRatio;
    if (budget >= 1 || index === 0) {
      kept.push(line);
      budget -= 1;
    }
  });
  return kept.join('\n');
}

// ───────────────────────── Read models & service constants ─────────────────────────

export const SERMON_QUERY_VISIBLE_STATUSES: SermonStatus[] = [
  'UPLOADING',
  'UPLOADED',
  'QUEUED',
  'TRANSCRIBING',
  'ANALYZING',
  'INDEXING',
  'READY',
  'FAILED',
];

export interface CreateSermonInput {
  title: string;
  speaker: string;
  sermonDate: Date;
  series?: string | null;
  mainScripture?: string | null;
  tags?: string[];
  objectKey?: string;
  transcriptText?: string;
}

export interface SermonStatusInfo {
  sermonId: string;
  status: SermonStatus;
  processingStage: ProcessingStage | null;
  failedStage: ProcessingStage | null;
  errorMessage: string | null;
  canRetry: boolean;
}

export const toStatusInfo = (sermon: Sermon): SermonStatusInfo => {
  const props = sermon.snapshot();
  return {
    sermonId: props.id,
    status: props.status,
    processingStage: props.status === 'READY' ? null : props.processingStage,
    failedStage: props.status === 'FAILED' ? props.failedStage : null,
    errorMessage: props.status === 'FAILED' ? props.errorMessage : null,
    canRetry: props.status === 'FAILED' && props.canRetry,
  };
};

export const sourceTypeFor = (kind: MediaKind): SermonSourceType =>
  kind === 'AUDIO' || kind === 'VIDEO' ? 'MEDIA' : 'DOCUMENT';

/** Read model returned by list/detail/search endpoints. */
export interface SermonView {
  id: string;
  title: string;
  speaker: string;
  sermonDate: Date;
  series: string | null;
  mainScripture: string | null;
  tags: string[];
  status: SermonStatus;
  processingStage: ProcessingStage | null;
  summary: string | null;
  mainTheme: string | null;
  scriptures: string[];
  themes: string[];
  contentCount: number;
  createdAt: Date;
}

export interface SermonFilter {
  statuses?: SermonStatus[];
  /** Matches title, speaker, series, main scripture. */
  q?: string;
  speaker?: string;
  series?: string;
  scripture?: string;
  theme?: string;
  tag?: string;
  year?: number;
}

export interface SermonAssetRecord {
  id: string;
  churchId: string;
  sermonId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  /** When the plan's source retention ends; null = kept (uploads from before retention existed). */
  expiresAt: Date | null;
  /** When the original was removed from storage (the record is kept). */
  deletedAt: Date | null;
}

// ───────────────────────── Service constants ─────────────────────────

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_TRANSCRIPT_CHARS = 200;
export const MAX_PASTED_TRANSCRIPT_CHARS = 1_000_000;
export const MIN_PIPELINE_WORDS = 50;
export const EMBEDDING_BATCH_SIZE = 64;
export const sermonCreateLockKey = (churchId: string) => `sermon:create:${churchId}`;
export const sermonLockKey = (sermonId: string) => `sermon:${sermonId}`;

/** Longer than any healthy run: every phase retries within minutes, so two idle hours means the job was lost. */
export const STUCK_SERMON_AFTER_MS = 2 * 3600 * 1000;
export const STUCK_SERMON_BATCH = 100;
export const INTERRUPTED_MESSAGE = 'Processing was interrupted. Please try again.';
export const EXPIRED_SOURCE_BATCH = 200;

export const RECOVER_STUCK_SERMONS_JOB = { queue: QUEUES.MAINTENANCE, name: 'recover-stuck-sermons' } as const;
export const RECOVER_STUCK_SERMONS_EVERY_MS = 10 * 60 * 1000;
export const PURGE_EXPIRED_SOURCES_JOB = { queue: QUEUES.MAINTENANCE, name: 'purge-expired-sermon-sources' } as const;
export const PURGE_EXPIRED_SOURCES_EVERY_MS = 60 * 60 * 1000;

// ───────────────────────── Errors ─────────────────────────

export const sermonNotFound = () => notFound('Sermon');

export const cannotRetry = () =>
  new DomainError('CONFLICT', 'CANNOT_RETRY', 'This sermon cannot be retried.');

export const intelligenceNotReady = () =>
  new DomainError('CONFLICT', 'NOT_READY', 'Sermon intelligence is not available yet.');

export const sourceNotProvided = (hasObject: boolean) =>
  validationError(
    hasObject ? 'transcriptText' : 'objectKey',
    'Provide either an uploaded file or a pasted transcript',
  );

export const transcriptTooShort = () =>
  validationError('transcriptText', 'The transcript is too short to analyse');
export const transcriptTooLong = () => validationError('transcriptText', 'The transcript is too long');

/** The stored sermon no longer belongs to this job's processing run. */
export class SermonSupersededError extends Error {
  constructor(sermonId: string) {
    super(`Sermon ${sermonId} was deleted, finished or retried while this job was running`);
    this.name = 'SermonSupersededError';
  }
}

// ───────────────────────── Responses ─────────────────────────

export interface SermonResponse extends Omit<SermonView, 'sermonDate' | 'createdAt'> {
  sermonDate: string;
  createdAt: string;
}

export const toSermonResponse = (view: SermonView): SermonResponse => ({
  ...view,
  sermonDate: view.sermonDate.toISOString(),
  createdAt: view.createdAt.toISOString(),
});

export const toSegmentResponse = (segment: TranscriptSegmentRecord) => ({
  id: segment.id,
  sequence: segment.sequence,
  startTimeMs: segment.startTimeMs,
  endTimeMs: segment.endTimeMs,
  text: segment.text,
  speakerLabel: segment.speakerLabel,
});

type IntelligenceItemResponse = { id: string; text: string; sourceSegmentId?: string };

const item = (entry: { id: string; text: string; sourceSegmentId: string | null }): IntelligenceItemResponse =>
  entry.sourceSegmentId
    ? { id: entry.id, text: entry.text, sourceSegmentId: entry.sourceSegmentId }
    : { id: entry.id, text: entry.text };

/** Web contract: themes = main theme first, then secondary themes. */
export const toIntelligenceResponse = (data: SermonIntelligence) => ({
  themes: [data.mainTheme, ...data.secondaryThemes].map(item),
  keyPoints: data.keyPoints.map(item),
  quotes: data.quotes.map(item),
  stories: data.stories.map(item),
  applications: data.applications.map(item),
  prayers: data.prayers.map(item),
  questions: data.questions.map(item),
});

// ───────────────────────── Request schemas ─────────────────────────

const isoDate = z
  .string({ error: 'Sermon date is required' })
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date')
  .transform((value) => new Date(value));
const tags = z.array(z.string().max(40)).max(20);

export const CreateSermonBody = z.object({
  title: z.string({ error: 'Title is required' }).min(1, 'Title is required').max(200),
  speaker: z.string({ error: 'Speaker is required' }).min(1, 'Speaker is required').max(120),
  sermonDate: isoDate,
  series: z.string().max(120).nullable().optional(),
  mainScripture: z.string().max(120).nullable().optional(),
  tags: tags.optional(),
  objectKey: z.string().max(512).optional(),
  transcriptText: z.string().max(MAX_PASTED_TRANSCRIPT_CHARS).optional(),
});

export const UpdateSermonBody = z
  .object({
    title: z.string().max(200),
    speaker: z.string().max(120),
    sermonDate: isoDate,
    series: z.string().max(120).nullable(),
    mainScripture: z.string().max(120).nullable(),
    tags,
  })
  .partial()
  .strict();

export const ListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .map((status) => status.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z.enum(
            ['UPLOADING', 'UPLOADED', 'QUEUED', 'TRANSCRIBING', 'ANALYZING', 'INDEXING', 'READY', 'FAILED', 'ARCHIVED'],
            { error: 'Unknown status' },
          ),
        )
        .optional(),
    ),
  q: z.string().trim().max(200).optional(),
  ...pageQuery,
});
