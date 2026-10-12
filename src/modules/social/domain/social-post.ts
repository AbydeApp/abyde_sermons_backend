import { DomainError } from '../../../shared/domain/domain-error.js';
import type { SocialErrorCode } from './social-errors.js';
import type { SocialPlatform } from './social-platform.js';

export const SOCIAL_POST_STATUSES = [
  'draft',
  'rendering',
  'ready',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'partially_published',
  'failed',
] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export const PUBLICATION_STATUSES = [
  'pending',
  'scheduled',
  'queued',
  'publishing',
  'processing',
  'published',
  'failed',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export interface SocialPost {
  id: string;
  churchId: string;
  contentId: string | null;
  caption: string;
  /** Platforms with a separate title (YouTube, TikTok photo posts); defaults from the caption. */
  title?: string;
  mediaAssetIds: string[];
  thumbnailAssetId?: string;
  /** UTC. */
  scheduledAt?: Date;
  /** IANA zone the user scheduled in (display context only). */
  timezone?: string;
  /** Persisted lifecycle status; `rendering` is derived for display (see effectivePostStatus). */
  status: SocialPostStatus;
  createdByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One target of a post: one platform through one connected account. */
export interface SocialPublication {
  id: string;
  churchId: string;
  socialPostId: string;
  connectionId: string;
  platform: SocialPlatform;
  status: PublicationStatus;
  providerPostId?: string;
  /** Provider handle while it processes media (container id, publish id…). */
  providerRef?: string;
  permalink?: string;
  attemptCount: number;
  pollCount: number;
  lastErrorCode?: SocialErrorCode;
  lastErrorMessage?: string;
  /** The decisive call may have succeeded: only retried when the user confirms it did not. */
  outcomeUnknown: boolean;
  /** Per-target choices (privacy level, tags…), validated per platform. */
  settings: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
  metrics?: Record<string, number>;
  metricsUpdatedAt?: Date;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialPostAggregate {
  post: SocialPost;
  publications: SocialPublication[];
}

const IN_FLIGHT: readonly PublicationStatus[] = [
  'queued',
  'publishing',
  'processing',
];
const NOT_STARTED: readonly PublicationStatus[] = ['pending', 'scheduled'];

export const isInFlight = (status: PublicationStatus) =>
  IN_FLIGHT.includes(status);

/**
 * Parent status from its publications once publishing has begun. One provider failing never
 * hides another's success: some published + the rest failed is `partially_published`.
 */
export function derivePostStatus(
  post: Pick<SocialPost, 'status'>,
  publications: Array<Pick<SocialPublication, 'status'>>,
): SocialPostStatus {
  if (publications.length === 0) return 'draft';
  const statuses = publications.map((publication) => publication.status);
  if (statuses.every((status) => NOT_STARTED.includes(status))) {
    if (statuses.some((status) => status === 'scheduled')) return 'scheduled';
    return post.status === 'draft' ? 'draft' : 'ready';
  }
  if (
    statuses.some(
      (status) => status === 'publishing' || status === 'processing',
    )
  )
    return 'publishing';
  if (statuses.some((status) => status === 'queued'))
    return statuses.some(
      (status) => status === 'published' || status === 'failed',
    )
      ? 'publishing'
      : 'queued';
  const published = statuses.filter((status) => status === 'published').length;
  if (published === statuses.length) return 'published';
  if (published > 0) return 'partially_published';
  if (statuses.some((status) => status === 'scheduled')) return 'scheduled';
  return 'failed';
}

/** Rendering is shown while any attached media is still being produced. */
export const effectivePostStatus = (
  status: SocialPostStatus,
  mediaPending: boolean,
): SocialPostStatus =>
  mediaPending && (status === 'ready' || status === 'draft')
    ? 'rendering'
    : status;

const conflict = (code: string, message: string) =>
  new DomainError('CONFLICT', code, message);

/** Content and targets can change only before anything was sent to a platform. */
export function assertEditable(aggregate: SocialPostAggregate): void {
  if (!aggregate.publications.every((p) => NOT_STARTED.includes(p.status)))
    throw conflict(
      'POST_ALREADY_PUBLISHING',
      'This post has already been sent to a platform and can no longer be edited.',
    );
}

/** A post can be removed while nothing is in flight and nothing went live. */
export function assertDeletable(aggregate: SocialPostAggregate): void {
  if (aggregate.publications.some((p) => isInFlight(p.status)))
    throw conflict(
      'POST_IN_FLIGHT',
      'This post is being published. Try again when it has finished.',
    );
  if (aggregate.publications.some((p) => p.status === 'published'))
    throw conflict(
      'POST_ALREADY_PUBLISHED',
      'This post is live on at least one platform. Remove it there first.',
    );
}

/** Publications a "publish now" or "schedule" may start. */
export function startablePublications(
  aggregate: SocialPostAggregate,
): SocialPublication[] {
  if (aggregate.publications.length === 0)
    throw new DomainError(
      'UNPROCESSABLE',
      'NO_TARGETS',
      'Choose at least one account to publish to.',
    );
  const startable = aggregate.publications.filter((p) =>
    NOT_STARTED.includes(p.status),
  );
  if (startable.length === 0)
    throw conflict(
      'POST_ALREADY_PUBLISHING',
      'This post has already been sent. Use retry for failed platforms.',
    );
  return startable;
}

/**
 * Failed publications a retry may restart. One whose outcome is unknown needs the user to
 * confirm it is not live, since retrying it could post twice.
 */
export function retryablePublications(
  aggregate: SocialPostAggregate,
  options: { publicationIds?: string[]; confirmNotPublished: boolean },
): SocialPublication[] {
  const failed = aggregate.publications.filter(
    (p) =>
      p.status === 'failed' &&
      (!options.publicationIds || options.publicationIds.includes(p.id)),
  );
  if (failed.length === 0)
    throw conflict(
      'NOTHING_TO_RETRY',
      'There are no failed platforms to retry.',
    );
  const unconfirmed = failed.filter(
    (p) => p.outcomeUnknown && !options.confirmNotPublished,
  );
  if (unconfirmed.length > 0)
    throw new DomainError(
      'CONFLICT',
      'CONFIRMATION_REQUIRED',
      "We couldn't confirm whether some platforms posted this. Check them, then retry with confirmNotPublished.",
      { publicationIds: unconfirmed.map((p) => p.id) },
    );
  return failed;
}

/** Scheduling needs a time at least a minute ahead and at most a year out. */
export function validateScheduleTime(scheduledAt: Date, now: Date): void {
  const ahead = scheduledAt.getTime() - now.getTime();
  if (ahead < 60_000)
    throw new DomainError(
      'UNPROCESSABLE',
      'VALIDATION_ERROR',
      'The request could not be processed.',
      { scheduledAt: ['Choose a time at least one minute from now'] },
    );
  if (ahead > 366 * 24 * 3600 * 1000)
    throw new DomainError(
      'UNPROCESSABLE',
      'VALIDATION_ERROR',
      'The request could not be processed.',
      { scheduledAt: ['Choose a time within the next year'] },
    );
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Title for platforms that need one: the post's title, else the caption's first line. */
export function titleFor(
  post: Pick<SocialPost, 'title' | 'caption'>,
  max: number,
): string {
  const source =
    post.title?.trim() || post.caption.split('\n')[0]?.trim() || '';
  return source.length <= max
    ? source
    : `${source.slice(0, max - 1).trimEnd()}…`;
}
