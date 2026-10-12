import type {
  Page,
  PageRequest,
} from '../../../../../shared/domain/pagination.js';
import type { SocialConnection } from '../../../domain/social-connection.js';
import type { SocialPlatform } from '../../../domain/social-platform.js';
import type {
  PublicationStatus,
  SocialPost,
  SocialPostAggregate,
  SocialPostStatus,
  SocialPublication,
} from '../../../domain/social-post.js';

export const SOCIAL_CONNECTION_REPOSITORY = Symbol(
  'SOCIAL_CONNECTION_REPOSITORY',
);

export interface SocialConnectionRepositoryPort {
  list(churchId: string): Promise<SocialConnection[]>;
  findById(churchId: string, id: string): Promise<SocialConnection | null>;
  findByIds(churchId: string, ids: string[]): Promise<SocialConnection[]>;
  findByAccount(
    churchId: string,
    platform: SocialPlatform,
    providerAccountId: string,
  ): Promise<SocialConnection | null>;
  /** Insert or full update by id. */
  save(connection: SocialConnection): Promise<void>;
  /** Other live connections sharing an OAuth grant (one consent, one provider token). */
  countConnectedByGrant(
    churchId: string,
    grantId: string,
    excludingId: string,
  ): Promise<number>;
  /**
   * Maintenance only (all churches): connected accounts whose token expires before `before`,
   * either with a refresh token (`refreshable`) or without one.
   */
  findExpiring(
    before: Date,
    limit: number,
    refreshable: boolean,
  ): Promise<SocialConnection[]>;
}

export interface SocialPostFilter {
  status?: SocialPostStatus;
  contentId?: string;
}

export interface DueTarget {
  churchId: string;
  socialPostId: string;
  publicationId: string;
  connectionId: string;
}

export const SOCIAL_POST_REPOSITORY = Symbol('SOCIAL_POST_REPOSITORY');

export interface SocialPostRepositoryPort {
  create(aggregate: SocialPostAggregate): Promise<void>;
  find(churchId: string, id: string): Promise<SocialPostAggregate | null>;
  list(
    churchId: string,
    filter: SocialPostFilter,
    page: PageRequest,
  ): Promise<Page<SocialPostAggregate>>;
  /** Writes the post's own columns (never its publications). */
  updatePost(post: SocialPost): Promise<void>;
  /** Replaces all targets of a post that has not started publishing. */
  replacePublications(
    churchId: string,
    socialPostId: string,
    publications: SocialPublication[],
  ): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  findPublication(
    churchId: string,
    id: string,
  ): Promise<SocialPublication | null>;
  /**
   * Compare-and-set: applies `patch` only while the publication is in one of `from`. This is
   * what makes concurrent workers safe: exactly one wins each transition.
   */
  transitionPublication(
    churchId: string,
    id: string,
    from: readonly PublicationStatus[],
    patch: Partial<
      Omit<SocialPublication, 'id' | 'churchId' | 'socialPostId'>
    > & {
      /** Increments attempt_count atomically with the transition. */
      incrementAttempt?: boolean;
    },
  ): Promise<boolean>;
  /**
   * Atomically moves due `scheduled` publications to `queued` (SKIP LOCKED: concurrent
   * dispatchers never claim the same row) and returns them.
   */
  claimDue(now: Date, limit: number): Promise<DueTarget[]>;
  /** Maintenance only (all churches): publications stuck in `status` since before `olderThan`. */
  findStale(
    status: PublicationStatus,
    olderThan: Date,
    limit: number,
  ): Promise<SocialPublication[]>;
  /** Bumps updated_at so a sweep does not pick the same rows again next tick. */
  touch(ids: string[]): Promise<void>;
  /** Maintenance only (all churches): published publications whose metrics are older than `staleBefore`. */
  findForMetrics(
    publishedAfter: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<SocialPublication[]>;
  saveMetrics(
    churchId: string,
    id: string,
    metrics: Record<string, number>,
    at: Date,
  ): Promise<void>;
}

export const SOCIAL_AUDIT_LOG = Symbol('SOCIAL_AUDIT_LOG');

export type SocialAuditAction =
  | 'connection.connected'
  | 'connection.reconnected'
  | 'connection.disconnected'
  | 'connection.expired'
  | 'connection.refreshed'
  | 'post.created'
  | 'post.scheduled'
  | 'post.publish_requested'
  | 'post.retry_requested'
  | 'post.deleted'
  | 'publication.published'
  | 'publication.failed';

export interface SocialAuditEntry {
  churchId: string;
  userId?: string;
  action: SocialAuditAction;
  connectionId?: string;
  socialPostId?: string;
  publicationId?: string;
  /** Safe details only: never tokens, codes or provider payloads. */
  detail?: Record<string, string | number | boolean | null>;
}

export interface SocialAuditLogPort {
  record(entry: SocialAuditEntry): Promise<void>;
}
