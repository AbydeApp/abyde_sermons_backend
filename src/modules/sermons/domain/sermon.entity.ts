import {
  DomainError,
  validationError,
} from '../../../shared/domain/domain-error.js';
import {
  type ProcessingStage,
  type SermonSourceType,
  type SermonStatus,
  statusForStage,
} from './processing.js';

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
