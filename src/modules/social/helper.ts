import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { DomainError, validationError } from '../../shared/domain/domain-error.js';
import type { PublishableAsset, SocialProviderRegistryPort } from './adapters/ports.js';

// ───────────────────────── Platforms ─────────────────────────

export const SocialPlatform = {
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  YOUTUBE: 'youtube',
  X: 'x',
  LINKEDIN: 'linkedin',
} as const;
export type SocialPlatform =
  (typeof SocialPlatform)[keyof typeof SocialPlatform];
export const SOCIAL_PLATFORMS = Object.values(SocialPlatform) as [
  SocialPlatform,
  ...SocialPlatform[],
];

/** The OAuth/API provider behind a platform (Meta serves both Facebook Pages and Instagram). */
export const SOCIAL_PROVIDERS = [
  'meta',
  'tiktok',
  'youtube',
  'x',
  'linkedin',
] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

export const PROVIDER_FOR_PLATFORM: Record<SocialPlatform, SocialProviderId> = {
  facebook: 'meta',
  instagram: 'meta',
  tiktok: 'tiktok',
  youtube: 'youtube',
  x: 'x',
  linkedin: 'linkedin',
};

export const PLATFORMS_FOR_PROVIDER: Record<
  SocialProviderId,
  readonly SocialPlatform[]
> = {
  meta: ['facebook', 'instagram'],
  tiktok: ['tiktok'],
  youtube: ['youtube'],
  x: ['x'],
  linkedin: ['linkedin'],
};

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  linkedin: 'LinkedIn',
};

export const isSocialPlatform = (value: string): value is SocialPlatform =>
  (SOCIAL_PLATFORMS as readonly string[]).includes(value);

export const isSocialProvider = (value: string): value is SocialProviderId =>
  (SOCIAL_PROVIDERS as readonly string[]).includes(value);

// ───────────────────────── Errors ─────────────────────────

export const SocialErrorCode = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_MEDIA: 'INVALID_MEDIA',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  PROVIDER_PROCESSING: 'PROVIDER_PROCESSING',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type SocialErrorCode =
  (typeof SocialErrorCode)[keyof typeof SocialErrorCode];

/**
 * Whether the provider may have published anything.
 * - `not_published`: the provider certainly did not publish (rejected, or the decisive call was never sent).
 * - `unknown`: the decisive call was sent but no answer was read (timeout, 5xx). Never retried
 *   automatically, because a duplicate public post is worse than a visible failure.
 */
export type PublishOutcomeCertainty = 'not_published' | 'unknown';

/**
 * Normalised provider failure. `message` is a diagnostic for secure logs only (never tokens);
 * clients see `SAFE_MESSAGES[code]`.
 */
export class SocialProviderError extends Error {
  readonly retryable: boolean;
  readonly outcome: PublishOutcomeCertainty;
  readonly providerRequestId?: string;
  readonly httpStatus?: number;

  constructor(
    readonly code: SocialErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      outcome?: PublishOutcomeCertainty;
      providerRequestId?: string;
      httpStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = 'SocialProviderError';
    this.outcome = options.outcome ?? 'not_published';
    // An unknown outcome is never retryable, whatever the caller said.
    this.retryable =
      this.outcome === 'not_published' &&
      (options.retryable ?? DEFAULT_RETRYABLE[code]);
    this.providerRequestId = options.providerRequestId;
    this.httpStatus = options.httpStatus;
  }
}

const DEFAULT_RETRYABLE: Record<SocialErrorCode, boolean> = {
  AUTH_EXPIRED: false,
  PERMISSION_DENIED: false,
  RATE_LIMITED: true,
  INVALID_MEDIA: false,
  UNSUPPORTED_CONTENT: false,
  PROVIDER_PROCESSING: true,
  PROVIDER_UNAVAILABLE: true,
  UNKNOWN: false,
};

/** Actionable text for the frontend. Provider diagnostics stay in logs. */
export const SAFE_MESSAGES: Record<SocialErrorCode, string> = {
  AUTH_EXPIRED:
    'The connection to this account has expired. Reconnect it and try again.',
  PERMISSION_DENIED:
    'This account did not grant permission to publish. Reconnect it and approve every requested permission.',
  RATE_LIMITED: 'The platform is limiting requests right now. Try again later.',
  INVALID_MEDIA:
    'The platform rejected the media. Check its format, size and length.',
  UNSUPPORTED_CONTENT: 'This platform does not support this kind of post.',
  PROVIDER_PROCESSING: 'The platform is still processing the media.',
  PROVIDER_UNAVAILABLE:
    'The platform is temporarily unavailable. Try again shortly.',
  UNKNOWN: 'Something went wrong while publishing.',
};

export const OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether this was posted. Check the account before retrying.";

export const asSocialProviderError = (
  error: unknown,
  decisiveCallMade: boolean,
): SocialProviderError =>
  error instanceof SocialProviderError
    ? error
    : new SocialProviderError(
        'UNKNOWN',
        `Unexpected adapter error: ${(error as Error)?.message ?? String(error)}`,
        {
          outcome: decisiveCallMade ? 'unknown' : 'not_published',
          retryable: false,
        },
      );

// ───────────────────────── Connections ─────────────────────────

export const CONNECTION_STATUSES = [
  'connected',
  'expired',
  'revoked',
  'error',
] as const;
export type SocialConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface SocialConnection {
  id: string;
  churchId: string;
  platform: SocialPlatform;
  provider: SocialProviderId;
  providerAccountId: string;
  accountName: string;
  avatarUrl?: string;
  /** Sealed with the token cipher; null once the connection is revoked. */
  encryptedAccessToken: string | null;
  encryptedRefreshToken?: string;
  tokenExpiresAt?: Date;
  scopes: string[];
  status: SocialConnectionStatus;
  /**
   * Non-secret provider details (page category, organisation URN…). `grantId` groups connections
   * created by one OAuth consent, which share a token at the provider.
   */
  metadata: Record<string, unknown>;
  connectedByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A connection with its tokens decrypted just in time. Never persisted, logged or returned. */
export interface AuthorizedAccount {
  connectionId: string;
  churchId: string;
  platform: SocialPlatform;
  providerAccountId: string;
  accountName: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
}

/** Refresh this long before expiry so a publish never starts with a token about to lapse. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const needsRefresh = (
  connection: Pick<SocialConnection, 'tokenExpiresAt'>,
  now: Date,
): boolean =>
  connection.tokenExpiresAt !== undefined &&
  connection.tokenExpiresAt.getTime() - now.getTime() < TOKEN_REFRESH_MARGIN_MS;

export const grantIdOf = (connection: Pick<SocialConnection, 'metadata'>) =>
  typeof connection.metadata.grantId === 'string'
    ? connection.metadata.grantId
    : undefined;

// ───────────────────────── Capabilities ─────────────────────────

/** What a platform accepts through our integration today. Generated by adapters, never assumed. */
export interface PlatformCapabilities {
  platform: SocialPlatform;
  /** Credentials for this provider are configured on the server. */
  configured: boolean;
  textOnly: boolean;
  images: boolean;
  carousel: boolean;
  video: boolean;
  shortVideo: boolean;
  /** Most images in one post (1 when carousels are unsupported). */
  maxImages: number;
  /** Fewest images a multi-image post needs (Instagram carousels need two). */
  minCarouselImages: number;
  maxCaptionLength: number;
  /** Platforms that show a separate title (YouTube, TikTok photo posts). */
  titleRequired: boolean;
  maxTitleLength: number;
  imageContentTypes: string[];
  videoContentTypes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  minVideoDurationSeconds: number;
  maxVideoDurationSeconds: number;
  /** Things the user must know (e.g. "posts are private until the app passes review"). */
  restrictions: string[];
}

export interface MediaFacts {
  type: 'image' | 'video';
  contentType: string;
  sizeBytes: number | null;
  durationMs: number | null;
}

/**
 * Checks a post against a platform's capabilities. Returns user-facing problems; empty = valid.
 * Unknown facts (media still rendering) are not held against the post until publish time.
 */
export function capabilityViolations(
  capabilities: PlatformCapabilities,
  post: { caption: string; title?: string | null; media: MediaFacts[] },
): string[] {
  const problems: string[] = [];
  const images = post.media.filter((item) => item.type === 'image');
  const videos = post.media.filter((item) => item.type === 'video');
  if (!capabilities.configured)
    problems.push('Publishing to this platform is not available yet.');
  if (post.caption.length > capabilities.maxCaptionLength)
    problems.push(
      `The caption is too long (max ${capabilities.maxCaptionLength} characters).`,
    );
  if (post.title && post.title.length > capabilities.maxTitleLength)
    problems.push(
      `The title is too long (max ${capabilities.maxTitleLength} characters).`,
    );
  if (post.media.length === 0) {
    if (!capabilities.textOnly)
      problems.push('This platform needs an image or a video.');
    else if (!post.caption.trim()) problems.push('Write a caption.');
    return problems;
  }
  if (images.length > 0 && videos.length > 0)
    problems.push('Use either images or one video, not both.');
  if (images.length > 0) {
    if (!capabilities.images)
      problems.push('This platform does not accept images.');
    else if (images.length > 1 && !capabilities.carousel)
      problems.push('This platform takes one image per post.');
    else if (images.length > capabilities.maxImages)
      problems.push(`Use at most ${capabilities.maxImages} images.`);
    else if (
      images.length > 1 &&
      images.length < capabilities.minCarouselImages
    )
      problems.push(
        `A multi-image post needs at least ${capabilities.minCarouselImages} images.`,
      );
    for (const image of images) {
      if (!capabilities.imageContentTypes.includes(image.contentType))
        problems.push(
          `Images must be ${capabilities.imageContentTypes.join(', ')}.`,
        );
      if (
        image.sizeBytes !== null &&
        image.sizeBytes > capabilities.maxImageBytes
      )
        problems.push('An image is larger than this platform allows.');
    }
  }
  if (videos.length > 0) {
    if (!capabilities.video)
      problems.push('This platform does not accept video.');
    else if (videos.length > 1) problems.push('Use one video per post.');
    for (const video of videos) {
      if (!capabilities.videoContentTypes.includes(video.contentType))
        problems.push(
          `Videos must be ${capabilities.videoContentTypes.join(', ')}.`,
        );
      if (
        video.sizeBytes !== null &&
        video.sizeBytes > capabilities.maxVideoBytes
      )
        problems.push('The video is larger than this platform allows.');
      if (video.durationMs !== null) {
        const seconds = video.durationMs / 1000;
        if (seconds < capabilities.minVideoDurationSeconds)
          problems.push(
            `The video must be at least ${capabilities.minVideoDurationSeconds} seconds long.`,
          );
        if (seconds > capabilities.maxVideoDurationSeconds)
          problems.push(
            `The video must be at most ${capabilities.maxVideoDurationSeconds} seconds long.`,
          );
      }
    }
  }
  if (capabilities.titleRequired && !post.title?.trim() && !post.caption.trim())
    problems.push('Add a title.');
  return [...new Set(problems)];
}

// ───────────────────────── Target settings ─────────────────────────

export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export const YOUTUBE_PRIVACY = ['public', 'unlisted', 'private'] as const;
export const LINKEDIN_VISIBILITY = ['PUBLIC', 'CONNECTIONS'] as const;

/**
 * Per-platform choices a user makes for one target. Some are required by platform policy rather
 * than by us (TikTok wants an explicit privacy choice, YouTube an explicit made-for-kids answer).
 */
export function validateTargetSettings(
  platform: SocialPlatform,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const field = (name: string) => `targets.${platform}.settings.${name}`;
  switch (platform) {
    case 'tiktok':
      if (!TIKTOK_PRIVACY_LEVELS.includes(settings.privacyLevel as never))
        throw validationError(
          field('privacyLevel'),
          'Choose who can see this TikTok',
        );
      return {
        privacyLevel: settings.privacyLevel,
        disableComment: settings.disableComment === true,
        disableDuet: settings.disableDuet === true,
        disableStitch: settings.disableStitch === true,
      };
    case 'youtube':
      if (!YOUTUBE_PRIVACY.includes(settings.privacyStatus as never))
        throw validationError(
          field('privacyStatus'),
          'Choose public, unlisted or private',
        );
      if (typeof settings.madeForKids !== 'boolean')
        throw validationError(
          field('madeForKids'),
          'Say whether this video is made for kids',
        );
      return {
        privacyStatus: settings.privacyStatus,
        madeForKids: settings.madeForKids,
        tags: Array.isArray(settings.tags)
          ? settings.tags
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim())
              .filter(Boolean)
              .slice(0, 30)
          : [],
      };
    case 'linkedin':
      return {
        visibility: LINKEDIN_VISIBILITY.includes(settings.visibility as never)
          ? settings.visibility
          : 'PUBLIC',
      };
    case 'instagram':
      return { shareToFeed: settings.shareToFeed !== false };
    case 'facebook':
      return { asReel: settings.asReel === true };
    case 'x':
      return {};
  }
}

// ───────────────────────── Posts and publications ─────────────────────────

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

// ───────────────────────── Views ─────────────────────────

/** Connection as the client sees it: never tokens, never raw provider metadata. */
export function toConnectionView(connection: SocialConnection) {
  return {
    id: connection.id,
    platform: connection.platform,
    platformLabel: PLATFORM_LABELS[connection.platform],
    provider: connection.provider,
    accountName: connection.accountName,
    avatarUrl: connection.avatarUrl ?? null,
    status: connection.status,
    needsReconnect:
      connection.status === 'expired' || connection.status === 'error',
    scopes: connection.scopes,
    tokenExpiresAt: connection.tokenExpiresAt?.toISOString() ?? null,
    connectedAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

function toPublicationView(publication: SocialPublication) {
  const failed = publication.status === 'failed';
  return {
    id: publication.id,
    platform: publication.platform,
    connectionId: publication.connectionId,
    status: publication.status,
    providerPostId: publication.providerPostId ?? null,
    permalink: publication.permalink ?? null,
    attemptCount: publication.attemptCount,
    error: failed
      ? {
          code: publication.lastErrorCode ?? 'UNKNOWN',
          message: publication.outcomeUnknown
            ? OUTCOME_UNKNOWN_MESSAGE
            : SAFE_MESSAGES[publication.lastErrorCode ?? 'UNKNOWN'],
          outcomeUnknown: publication.outcomeUnknown,
        }
      : null,
    // The account must be reconnected before this target can be retried.
    requiresReauth: failed && publication.lastErrorCode === 'AUTH_EXPIRED',
    settings: publication.settings,
    metrics: publication.metrics ?? null,
    publishedAt: publication.publishedAt?.toISOString() ?? null,
    updatedAt: publication.updatedAt.toISOString(),
  };
}

export function toPostView(
  aggregate: SocialPostAggregate,
  mediaPending = false,
) {
  const { post } = aggregate;
  return {
    id: post.id,
    contentId: post.contentId,
    caption: post.caption,
    title: post.title ?? null,
    mediaAssetIds: post.mediaAssetIds,
    thumbnailAssetId: post.thumbnailAssetId ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    timezone: post.timezone ?? null,
    status: effectivePostStatus(post.status, mediaPending),
    publications: aggregate.publications.map(toPublicationView),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export const toCapabilitiesView = (capabilities: PlatformCapabilities[]) =>
  Object.fromEntries(
    capabilities.map(({ platform, ...rest }) => [platform, rest]),
  );

// ───────────────────────── Post validation ─────────────────────────

export const POSTABLE_KINDS = new Set(['IMAGE', 'CAROUSEL_SLIDE', 'VIDEO']);

export interface MediaCheck {
  /** Ordered as the post lists them. */
  assets: PublishableAsset[];
  thumbnail?: PublishableAsset;
  pending: boolean;
}

export const invalid = (field: string, message: string) =>
  new DomainError('UNPROCESSABLE', 'VALIDATION_ERROR', 'The request could not be processed.', {
    [field]: [message],
  });

/** Target connections must belong to the church, be usable, and match the requested platform. */
export function checkTargets(
  targets: Array<{ platform: SocialPlatform; connectionId: string }>,
  connections: SocialConnection[],
): void {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.connectionId)) throw invalid('targets', 'Each account can be targeted once');
    seen.add(target.connectionId);
    const connection = byId.get(target.connectionId);
    // Another church's connection is indistinguishable from a missing one.
    if (!connection) throw invalid('targets', 'Account not found');
    if (connection.platform !== target.platform)
      throw invalid('targets', `That account is not a ${PLATFORM_LABELS[target.platform]} account`);
    if (connection.status !== 'connected')
      throw new DomainError(
        'UNPROCESSABLE',
        'CONNECTION_NOT_ACTIVE',
        `Reconnect ${connection.accountName} on ${PLATFORM_LABELS[connection.platform]} first.`,
      );
  }
}

/** The current capabilities of one platform, as its adapter reports them. */
export async function capabilitiesFor(
  registry: SocialProviderRegistryPort,
  platform: SocialPlatform,
): Promise<PlatformCapabilities> {
  const all = await registry.forPlatform(platform).getCapabilities();
  const capabilities = all.find((entry) => entry.platform === platform);
  if (!capabilities) throw new Error(`No capabilities for ${platform}`);
  return capabilities;
}

/** Capability check per target platform; problems are reported per platform. */
export async function checkCapabilities(
  registry: SocialProviderRegistryPort,
  post: Pick<SocialPost, 'caption' | 'title'>,
  media: PublishableAsset[],
  platforms: SocialPlatform[],
): Promise<void> {
  const facts: MediaFacts[] = media.map((asset) => ({
    type: asset.contentType.startsWith('video/') ? 'video' : 'image',
    contentType: asset.contentType,
    sizeBytes: asset.status === 'READY' ? asset.sizeBytes : null,
    durationMs: asset.status === 'READY' ? asset.durationMs : null,
  }));
  const errors: Record<string, string[]> = {};
  for (const platform of new Set(platforms)) {
    const problems = capabilityViolations(await capabilitiesFor(registry, platform), {
      caption: post.caption,
      title: post.title,
      media: facts,
    });
    if (problems.length > 0) errors[`targets.${platform}`] = problems;
  }
  if (Object.keys(errors).length > 0)
    throw new DomainError(
      'UNPROCESSABLE',
      'UNSUPPORTED_FOR_PLATFORM',
      'Some platforms cannot publish this post as it is.',
      errors,
    );
}

// ───────────────────────── Service types & constants ─────────────────────────

export interface Actor {
  churchId: string;
  userId: string;
}

export const OAUTH_STATE_TTL_SECONDS = 600;
export const SELECTION_TTL_SECONDS = 600;
export const REFRESH_LOCK_TTL_SECONDS = 60;
export const oauthStateKey = (hash: string) => `social:oauth-state:${hash}`;
export const selectionKey = (id: string) => `social:oauth-selection:${id}`;
export const refreshLockKey = (connectionId: string) => `social:refresh-lock:${connectionId}`;
export const connectionsLock = (churchId: string) => `social-connections:${churchId}`;
export const postLock = (postId: string) => `social-post:${postId}`;

/** Associated data binding a sealed token to its connection and church. */
export const tokenContext = (connection: Pick<SocialConnection, 'id' | 'churchId'>, kind: 'access' | 'refresh') =>
  `social:${connection.churchId}:${connection.id}:${kind}`;

/** Server-side OAuth state: who started the flow, for what, and the PKCE verifier. */
export interface PendingAuthorization {
  churchId: string;
  userId: string;
  provider: SocialProviderId;
  platforms: SocialPlatform[];
  codeVerifier: string;
  reconnectConnectionId?: string;
}

export interface PendingAccount {
  ref: string;
  platform: SocialPlatform;
  providerAccountId: string;
  accountName: string;
  avatarUrl?: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  tokenExpiresAt?: string;
  /** Tokens sealed with the token cipher, bound to this selection. */
  sealedTokens: string;
}

/** Accounts found by an OAuth exchange, waiting for the user to choose (multi-Page/org grants). */
export interface PendingSelection {
  churchId: string;
  userId: string;
  provider: SocialProviderId;
  grantId: string;
  accounts: PendingAccount[];
}

export interface PendingAccountView {
  ref: string;
  platform: SocialPlatform;
  accountName: string;
  avatarUrl: string | null;
  alreadyConnected: boolean;
}

export interface AuthorizationOutcome {
  provider: SocialProviderId;
  /** Set when exactly one account was connected (or reconnected). */
  connectionId?: string;
  /** Set when the grant has several accounts and the user must choose which to connect. */
  selectionId?: string;
}

export const invalidOAuthState = () =>
  new DomainError('UNPROCESSABLE', 'INVALID_OAUTH_STATE', 'This connection link is invalid or has expired. Start again.');
export const noAccounts = () =>
  new DomainError('UNPROCESSABLE', 'NO_ACCOUNTS', 'No accounts were available to connect.');
export const connectionFailed = () =>
  new DomainError('UNAVAILABLE', 'CONNECTION_FAILED', 'We could not complete the connection. Please try again.');
export const accountMismatch = () =>
  new DomainError('UNPROCESSABLE', 'ACCOUNT_MISMATCH', 'That is a different account from the one you are reconnecting.');
export const providerNotConfigured = () =>
  new DomainError('UNAVAILABLE', 'PROVIDER_NOT_CONFIGURED', 'This platform is not available yet.');
export const providerUnavailable = () =>
  new DomainError('UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'The platform did not respond. Try again shortly.');
export const mediaNotReady = () =>
  new DomainError(
    'CONFLICT',
    'MEDIA_NOT_READY',
    'The media for this post is still rendering. Try again in a moment, or schedule it.',
  );
export const RECONNECT_RESTRICTION = 'Reconnect this account to publish.';

export interface PostTarget {
  platform: SocialPlatform;
  connectionId: string;
  settings?: Record<string, unknown>;
}

export interface SocialPostInput {
  /** The generated content the post comes from; absent for posts made from a Reel. */
  contentId?: string;
  caption: string;
  title?: string;
  mediaAssetIds: string[];
  thumbnailAssetId?: string;
  targets: PostTarget[];
}

export interface PostResult {
  aggregate: SocialPostAggregate;
  mediaPending: boolean;
}

export const normalisePostInput = (input: SocialPostInput): SocialPostInput => ({
  ...input,
  caption: input.caption.trim(),
  title: input.title?.trim() || undefined,
});

/** `social-publish` job: one per publication (target), so platforms fail independently. */
export interface SocialPublishJob {
  publicationId: string;
  churchId: string;
  connectionId: string;
}

export interface SocialStatusJob {
  publicationId: string;
  churchId: string;
  pollCount: number;
}

export const PUBLISH_PUBLICATION_JOB = { queue: QUEUES.SOCIAL_PUBLISH, name: 'publish' } as const;
export const DISPATCH_SOCIAL_JOB = { queue: QUEUES.SOCIAL_PUBLISH, name: 'dispatch-due' } as const;
export const CHECK_PUBLICATION_JOB = { queue: QUEUES.SOCIAL_STATUS, name: 'check' } as const;
export const REFRESH_TOKENS_JOB = { queue: QUEUES.TOKEN_MAINTENANCE, name: 'refresh-expiring' } as const;
export const COLLECT_METRICS_JOB = { queue: QUEUES.SOCIAL_METRICS, name: 'collect' } as const;
export const DISPATCH_EVERY_MS = 60_000;
export const REFRESH_EVERY_MS = 30 * 60_000;
export const METRICS_EVERY_MS = 6 * 3600_000;

export const DISPATCH_BATCH = 100;
/** Longer than the queue's whole retry backoff, so a publication waiting on a retry is left alone. */
export const STALE_QUEUED_MS = 30 * 60 * 1000;
/** Longer than a social-publish attempt may run: a publication still publishing has lost its worker. */
export const STALE_PUBLISHING_MS = 30 * 60 * 1000;
export const STALE_PROCESSING_MS = 15 * 60 * 1000;
export const MAX_STATUS_POLLS = 120;
export const MAX_POLL_DELAY_SECONDS = 300;
export const TOKEN_LOOKAHEAD_MS = 2 * 3600 * 1000;
export const REFRESH_BATCH = 50;
export const EXPIRE_BATCH = 200;
export const METRICS_WINDOW_MS = 30 * 24 * 3600 * 1000;
export const METRICS_STALE_MS = 6 * 3600 * 1000;
export const METRICS_BATCH = 50;

/** Delay before the next status check: grows every ten polls, capped. */
export const pollDelaySeconds = (checkAfterSeconds: number, pollCount: number) =>
  Math.min(MAX_POLL_DELAY_SECONDS, Math.max(5, checkAfterSeconds) * (1 + Math.floor(pollCount / 10)));

export async function withRetries<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}
