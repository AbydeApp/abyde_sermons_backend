import type { PlatformCapabilities } from '../domain/capabilities.js';
import {
  OUTCOME_UNKNOWN_MESSAGE,
  SAFE_MESSAGES,
} from '../domain/social-errors.js';
import type { SocialConnection } from '../domain/social-connection.js';
import { PLATFORM_LABELS } from '../domain/social-platform.js';
import {
  effectivePostStatus,
  type SocialPostAggregate,
  type SocialPublication,
} from '../domain/social-post.js';

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
