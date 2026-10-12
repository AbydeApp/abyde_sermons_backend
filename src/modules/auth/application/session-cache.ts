import type { CachePort } from '../../../shared/application/ports/cache.port.js';

export interface CachedSession {
  sessionId: string;
  userId: string;
  expiresAt: string;
  lastSeenAt: string;
}

export const SESSION_CACHE_SECONDS = 60;

export const sessionCacheKey = (tokenHash: string) => `session:${tokenHash}`;
export const sessionRevokedKey = (tokenHash: string) =>
  `session-revoked:${tokenHash}`;
export const churchIdCacheKey = (userId: string) => `church-id:${userId}`;

/**
 * Removes cached sessions and leaves a short-lived tombstone for each. A request that read the
 * session from the database just before it was revoked may re-populate the cache afterwards;
 * the tombstone (which outlives any such entry) makes the resolver discard it.
 */
export async function evictSessions(
  cache: CachePort,
  tokenHashes: string[],
): Promise<void> {
  if (tokenHashes.length === 0) return;
  for (const hash of tokenHashes) {
    await cache.set(sessionRevokedKey(hash), 1, SESSION_CACHE_SECONDS * 2);
  }
  await cache.del(...tokenHashes.map(sessionCacheKey));
}
