import { Inject, Injectable } from '@nestjs/common';
import { type AuthContext, CHURCH_DIRECTORY, type ChurchDirectoryPort } from '../../../../shared/application/auth-context.js';
import { CACHE, type CachePort } from '../../../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../../../shared/application/ports/secret-box.port.js';
import { SESSION_REPOSITORY, type SessionRepositoryPort } from '../ports/out/session-repository.port.js';
import {
  type CachedSession,
  churchIdCacheKey,
  SESSION_CACHE_SECONDS,
  sessionCacheKey,
  sessionRevokedKey,
} from '../session-cache.js';

const CHURCH_ID_CACHE_SECONDS = 3600;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/** Resolves a session cookie into an AuthContext. Hot path: cached in Redis, evicted on revocation. */
@Injectable()
export class ResolveSessionUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(CHURCH_DIRECTORY) private readonly churches: ChurchDirectoryPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(token: string): Promise<AuthContext | null> {
    if (token.length < 20 || token.length > 200) return null;
    const hash = this.tokens.hash(token);
    const now = this.clock.now();
    let session = await this.cache.get<CachedSession>(sessionCacheKey(hash));
    let wroteCache = false;
    if (!session) {
      const record = await this.sessions.findByTokenHash(hash);
      if (!record || record.revokedAt || record.expiresAt <= now) return null;
      session = {
        sessionId: record.id,
        userId: record.userId,
        expiresAt: record.expiresAt.toISOString(),
        lastSeenAt: record.lastSeenAt.toISOString(),
      };
      await this.cache.set(
        sessionCacheKey(hash),
        session,
        SESSION_CACHE_SECONDS,
      );
      wroteCache = true;
    }
    if (new Date(session.expiresAt) <= now) return null;
    if (
      now.getTime() - new Date(session.lastSeenAt).getTime() >
      TOUCH_INTERVAL_MS
    ) {
      await this.sessions.touch(session.sessionId, now);
      await this.cache.set(
        sessionCacheKey(hash),
        { ...session, lastSeenAt: now.toISOString() },
        SESSION_CACHE_SECONDS,
      );
      wroteCache = true;
    }
    // If the session was revoked while this request was filling the cache, undo the fill.
    if (
      wroteCache &&
      (await this.cache.get(sessionRevokedKey(hash))) !== null
    ) {
      await this.cache.del(sessionCacheKey(hash));
      return null;
    }
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      churchId: await this.churchIdFor(session.userId),
    };
  }

  private async churchIdFor(userId: string): Promise<string | null> {
    const cached = await this.cache.get<string>(churchIdCacheKey(userId));
    if (cached) return cached;
    const churchId = await this.churches.findIdByUserId(userId);
    // A church never changes owner, so positive results are safe to cache; misses are not cached.
    if (churchId)
      await this.cache.set(
        churchIdCacheKey(userId),
        churchId,
        CHURCH_ID_CACHE_SECONDS,
      );
    return churchId;
  }
}
