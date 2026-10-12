import type {
  Page,
  PageRequest,
} from '../../../../../shared/domain/pagination.js';
import type {
  ProcessingStage,
  SermonStatus,
} from '../../../domain/processing.js';
import type { Sermon } from '../../../domain/sermon.entity.js';

export const SERMON_REPOSITORY = Symbol('SERMON_REPOSITORY');

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

export interface SermonRepositoryPort {
  /** Always scoped: a sermon from another church is indistinguishable from a missing one. */
  findById(churchId: string, id: string): Promise<Sermon | null>;
  insert(sermon: Sermon): Promise<void>;
  /** Writes only the user-editable details. False when the sermon no longer exists. */
  updateDetails(sermon: Sermon): Promise<boolean>;
  /**
   * Writes only processing state (status, stage, failure, analysis results), and only if the stored
   * sermon is still being processed in the same run (`processingAttempts`). Returns false when the
   * sermon was deleted, finished, failed or retried meanwhile, so a stale worker can never
   * resurrect a deleted sermon, overwrite a user's edit or regress a finished one.
   */
  updateProcessing(sermon: Sermon): Promise<boolean>;
  /** FAILED → QUEUED for a new run. False when the stored sermon is not the failed run being retried. */
  updateForRetry(sermon: Sermon): Promise<boolean>;
  addAsset(asset: SermonAssetRecord): Promise<void>;
  findAssets(churchId: string, sermonId: string): Promise<SermonAssetRecord[]>;
  /** Maintenance only (all churches): originals past retention that are still stored. */
  findExpiredAssets(now: Date, limit: number): Promise<SermonAssetRecord[]>;
  markAssetDeleted(churchId: string, id: string, at: Date): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  /** Maintenance only (all churches): sermons still processing with no change since `olderThan`. */
  findStuckProcessing(olderThan: Date, limit: number): Promise<Sermon[]>;
}

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

export const SERMON_QUERY = Symbol('SERMON_QUERY');

export interface SermonQueryPort {
  list(
    churchId: string,
    filter: SermonFilter,
    page: PageRequest,
  ): Promise<Page<SermonView>>;
  findView(churchId: string, id: string): Promise<SermonView | null>;
  /** Views in the order of `ids` (ids from other churches are dropped). */
  findViews(churchId: string, ids: string[]): Promise<SermonView[]>;
  /** Ids of READY sermons matching the filter (for semantic re-ranking). */
  matchingIds(churchId: string, filter: SermonFilter): Promise<string[]>;
  latest(churchId: string): Promise<SermonView | null>;
}
