import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../shared/application/ports/cache.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../shared/application/ports/clock.port.js';
import { SocialProviderError } from '../domain/social-errors.js';
import {
  type AuthorizedAccount,
  needsRefresh,
  type SocialConnection,
} from '../domain/social-connection.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  type SocialAuditLogPort,
  type SocialConnectionRepositoryPort,
} from './ports/out/social-repositories.port.js';
import {
  SOCIAL_PROVIDER_REGISTRY,
  type SocialProviderRegistryPort,
} from './ports/out/social-publishing.port.js';
import {
  SOCIAL_OBSERVER,
  SOCIAL_TOKEN_CIPHER,
  type SocialObserverPort,
  type TokenCipherPort,
} from './ports/out/social-support.ports.js';

/** Associated data binding a sealed token to its connection and church. */
export const tokenContext = (
  connection: Pick<SocialConnection, 'id' | 'churchId'>,
  kind: 'access' | 'refresh',
) => `social:${connection.churchId}:${connection.id}:${kind}`;

const REFRESH_LOCK_TTL_SECONDS = 60;

/**
 * The only place provider tokens are decrypted. Tokens are opened just in time for one provider
 * call and refreshed when close to expiry. A refresh is serialised per connection through a shared
 * lock, because providers that rotate refresh tokens (TikTok, X) invalidate the old one on use: two
 * concurrent refreshes would lock the account out.
 */
@Injectable()
export class ConnectionAccessService {
  private readonly logger = new Logger(ConnectionAccessService.name);

  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_TOKEN_CIPHER) private readonly cipher: TokenCipherPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SOCIAL_OBSERVER) private readonly observer: SocialObserverPort,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
  ) {}

  /** Seals tokens for storage on `connection` (which must already have its final id). */
  seal(
    connection: Pick<SocialConnection, 'id' | 'churchId'>,
    tokens: { accessToken: string; refreshToken?: string },
  ): Pick<SocialConnection, 'encryptedAccessToken' | 'encryptedRefreshToken'> {
    return {
      encryptedAccessToken: this.cipher.encrypt(
        tokens.accessToken,
        tokenContext(connection, 'access'),
      ),
      encryptedRefreshToken: tokens.refreshToken
        ? this.cipher.encrypt(
            tokens.refreshToken,
            tokenContext(connection, 'refresh'),
          )
        : undefined,
    };
  }

  /** Decrypts without any refresh (revocation, account capability lookups). */
  open(connection: SocialConnection): AuthorizedAccount {
    if (!connection.encryptedAccessToken)
      throw new SocialProviderError(
        'AUTH_EXPIRED',
        `Connection ${connection.id} has no stored token`,
      );
    return {
      connectionId: connection.id,
      churchId: connection.churchId,
      platform: connection.platform,
      providerAccountId: connection.providerAccountId,
      accountName: connection.accountName,
      scopes: connection.scopes,
      metadata: connection.metadata,
      accessToken: this.cipher.decrypt(
        connection.encryptedAccessToken,
        tokenContext(connection, 'access'),
      ),
      refreshToken: connection.encryptedRefreshToken
        ? this.cipher.decrypt(
            connection.encryptedRefreshToken,
            tokenContext(connection, 'refresh'),
          )
        : undefined,
      tokenExpiresAt: connection.tokenExpiresAt,
    };
  }

  /**
   * A usable account for publishing. Throws SocialProviderError: AUTH_EXPIRED when the user must
   * reconnect, PROVIDER_UNAVAILABLE (retryable) when another worker is refreshing right now.
   */
  async authorize(connection: SocialConnection): Promise<AuthorizedAccount> {
    if (connection.status !== 'connected')
      throw new SocialProviderError(
        'AUTH_EXPIRED',
        `Connection ${connection.id} is ${connection.status}`,
      );
    if (!needsRefresh(connection, this.clock.now()))
      return this.open(connection);
    return this.refresh(connection);
  }

  /**
   * `proactive` (token maintenance) refreshes ahead of the publish-time margin; either way a
   * connection someone else refreshed meanwhile is returned as is.
   */
  async refresh(
    connection: SocialConnection,
    options: { proactive?: boolean } = {},
  ): Promise<AuthorizedAccount> {
    const lock = `social:refresh-lock:${connection.id}`;
    if (!(await this.cache.setIfAbsent(lock, 1, REFRESH_LOCK_TTL_SECONDS)))
      throw new SocialProviderError(
        'PROVIDER_UNAVAILABLE',
        `Token refresh for ${connection.id} already in progress`,
        { retryable: true },
      );
    try {
      // Re-read under the lock: another worker may have refreshed it a moment ago.
      const current = await this.connections.findById(
        connection.churchId,
        connection.id,
      );
      if (!current || current.status !== 'connected')
        throw new SocialProviderError(
          'AUTH_EXPIRED',
          `Connection ${connection.id} is gone`,
        );
      const refreshedMeanwhile =
        current.tokenExpiresAt?.getTime() !==
        connection.tokenExpiresAt?.getTime();
      if (
        refreshedMeanwhile ||
        (!options.proactive && !needsRefresh(current, this.clock.now()))
      )
        return this.open(current);
      const account = this.open(current);
      const adapter = this.registry.forProvider(current.provider);
      let refreshed;
      try {
        refreshed = await adapter.refreshConnection(account);
      } catch (error) {
        if (
          error instanceof SocialProviderError &&
          error.code === 'AUTH_EXPIRED'
        )
          await this.expire(current, 'refresh rejected');
        else
          this.observer.tokenRefresh({
            provider: current.provider,
            outcome: 'failed',
          });
        throw error;
      }
      if (!refreshed) {
        // Cannot be refreshed (no refresh token): usable until it actually expires.
        if (
          current.tokenExpiresAt &&
          current.tokenExpiresAt <= this.clock.now()
        ) {
          await this.expire(current, 'token expired without refresh token');
          throw new SocialProviderError(
            'AUTH_EXPIRED',
            `Connection ${current.id} expired`,
          );
        }
        return account;
      }
      const updated: SocialConnection = {
        ...current,
        ...this.seal(current, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? account.refreshToken,
        }),
        tokenExpiresAt: refreshed.tokenExpiresAt,
        scopes: refreshed.scopes ?? current.scopes,
        updatedAt: this.clock.now(),
      };
      await this.connections.save(updated);
      this.observer.tokenRefresh({
        provider: current.provider,
        outcome: 'refreshed',
      });
      return this.open(updated);
    } finally {
      await this.cache.del(lock);
    }
  }

  /** Marks the connection expired (the user must reconnect) and keeps no usable token. */
  async expire(connection: SocialConnection, reason: string): Promise<void> {
    if (connection.status !== 'connected') return;
    await this.connections.save({
      ...connection,
      status: 'expired',
      updatedAt: this.clock.now(),
    });
    this.observer.tokenRefresh({
      provider: connection.provider,
      outcome: 'expired',
    });
    await this.audit.record({
      churchId: connection.churchId,
      action: 'connection.expired',
      connectionId: connection.id,
      detail: { platform: connection.platform, reason },
    });
    this.logger.log(
      { connectionId: connection.id, platform: connection.platform, reason },
      'Social connection expired',
    );
  }
}
