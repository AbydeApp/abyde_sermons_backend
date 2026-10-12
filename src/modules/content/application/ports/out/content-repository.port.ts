import type {
  Page,
  PageRequest,
} from '../../../../../shared/domain/pagination.js';
import type {
  CalendarItem,
  CalendarItemStatus,
} from '../../../domain/calendar-item.entity.js';
import type {
  ContentItem,
  ContentItemProps,
  ContentVersionRecord,
} from '../../../domain/content-item.entity.js';
import type {
  ContentStatus,
  ContentType,
} from '../../../domain/content-types.js';
import type {
  GenerationGroupRecord,
  GenerationJobRecord,
} from '../../../domain/generation-group.js';

export const CONTENT_REPOSITORY = Symbol('CONTENT_REPOSITORY');

export interface ContentRepositoryPort {
  findById(churchId: string, id: string): Promise<ContentItem | null>;
  /** Upserts the item and appends its pending versions. */
  save(item: ContentItem): Promise<void>;
  saveMany(items: ContentItem[]): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  /** Removes partial output from an earlier attempt of the same generation job (retry idempotency). */
  deleteByGenerationJob(
    churchId: string,
    generationJobId: string,
  ): Promise<void>;
  listVersions(churchId: string, id: string): Promise<ContentVersionRecord[]>;
  findVersion(
    churchId: string,
    id: string,
    version: number,
  ): Promise<ContentVersionRecord | null>;
}

export interface ContentRow extends ContentItemProps {
  sermonTitle: string;
  calendarItemId: string | null;
}

export interface ContentFilter {
  status?: ContentStatus;
  type?: ContentType;
  sermonId?: string;
  q?: string;
  /** false → only items without a calendar entry; true → only scheduled items. */
  scheduled?: boolean;
}

export const CONTENT_QUERY = Symbol('CONTENT_QUERY');

export interface ContentQueryPort {
  list(
    churchId: string,
    filter: ContentFilter,
    page: PageRequest,
  ): Promise<Page<ContentRow>>;
  findRows(churchId: string, ids: string[]): Promise<ContentRow[]>;
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

export const CALENDAR_REPOSITORY = Symbol('CALENDAR_REPOSITORY');

export interface CalendarRepositoryPort {
  findById(churchId: string, id: string): Promise<CalendarItem | null>;
  findByContentItem(
    churchId: string,
    contentItemId: string,
  ): Promise<CalendarItem | null>;
  save(item: CalendarItem): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  findRows(churchId: string, ids: string[]): Promise<CalendarRow[]>;
  listRange(churchId: string, from: Date, to: Date): Promise<CalendarRow[]>;
}

export const GENERATION_REPOSITORY = Symbol('GENERATION_REPOSITORY');

export interface GenerationRepositoryPort {
  latestGroup(
    churchId: string,
    sermonId: string,
  ): Promise<GenerationGroupRecord | null>;
  findGroup(
    churchId: string,
    sermonId: string,
    groupId: string,
  ): Promise<GenerationGroupRecord | null>;
  createGroup(group: Omit<GenerationGroupRecord, 'jobs'>): Promise<void>;
  addJobs(jobs: GenerationJobRecord[]): Promise<void>;
  findJob(churchId: string, jobId: string): Promise<GenerationJobRecord | null>;
  updateJob(job: GenerationJobRecord): Promise<void>;
  /** Maintenance only: fails unfinished jobs with no update since `olderThan`; returns how many. */
  failStale(olderThan: Date, errorMessage: string): Promise<number>;
}
