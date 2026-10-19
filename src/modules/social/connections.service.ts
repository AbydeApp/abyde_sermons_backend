import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../shared/application/ports/secret-box.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { notFound, validationError } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import {
  type AccountCapabilities, type ConnectedAccount, SOCIAL_OBSERVER, SOCIAL_PROVIDER_REGISTRY, SOCIAL_SETTINGS,
  SOCIAL_TOKEN_CIPHER, type SocialObserverPort, type SocialProviderRegistryPort, type SocialSettings, type TokenCipherPort,
} from './adapters/ports.js';
import {
  accountMismatch, type Actor, type AuthorizationOutcome, type AuthorizedAccount, connectionFailed, connectionsLock,
  grantIdOf, invalidOAuthState, needsRefresh, noAccounts, OAUTH_STATE_TTL_SECONDS, oauthStateKey,
  type PendingAccountView, type PendingAuthorization, type PendingSelection, PLATFORMS_FOR_PROVIDER,
  type PlatformCapabilities, providerNotConfigured, providerUnavailable, RECONNECT_RESTRICTION, REFRESH_LOCK_TTL_SECONDS,
  refreshLockKey, SELECTION_TTL_SECONDS, selectionKey, type SocialConnection, type SocialPlatform, SocialProviderError,
  type SocialProviderId, tokenContext,
} from './helper.js';
import {
  SOCIAL_AUDIT_LOG, SOCIAL_CONNECTION_REPOSITORY, type SocialAuditLogPort, type SocialConnectionRepositoryPort,
} from './social.repository.js';

/**
 * Connected social accounts: the OAuth flow, account selection, disconnecting, capabilities, and
 * the only place provider tokens are decrypted (just in time, refreshed when close to expiry).
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY) private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY) private readonly registry: SocialProviderRegistryPort,
    @Inject(SOCIAL_TOKEN_CIPHER) private readonly cipher: TokenCipherPort,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(SOCIAL_OBSERVER) private readonly observer: SocialObserverPort,
    @Inject(SOCIAL_SETTINGS) private readonly settings: SocialSettings,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  // ───────────── Accounts ─────────────

  /** Revoked connections are history, not accounts: they are not listed. */
  async list(churchId: string): Promise<SocialConnection[]> {
    return (await this.connections.list(churchId)).filter((connection) => connection.status !== 'revoked');
  }

  async platformCapabilities(): Promise<PlatformCapabilities[]> {
    return (await Promise.all(this.registry.all().map((adapter) => adapter.getCapabilities()))).flat();
  }

  /** Account-specific limits (e.g. a TikTok creator's privacy options and maximum duration). */
  async accountCapabilities(churchId: string, connectionId: string): Promise<AccountCapabilities> {
    const connection = await this.connections.findById(churchId, connectionId);
    if (!connection || connection.status === 'revoked') throw notFound('Connection');
    const adapter = this.registry.forPlatform(connection.platform);
    if (!adapter.getAccountCapabilities || connection.status !== 'connected')
      return {
        platform: connection.platform,
        canPost: connection.status === 'connected',
        restrictions: connection.status === 'connected' ? [] : [RECONNECT_RESTRICTION],
      };
    try {
      return await adapter.getAccountCapabilities(await this.authorize(connection));
    } catch (error) {
      if (error instanceof SocialProviderError && error.code === 'AUTH_EXPIRED')
        return { platform: connection.platform, canPost: false, restrictions: [RECONNECT_RESTRICTION] };
      throw providerUnavailable();
    }
  }

  /**
   * Idempotent. Stored tokens are wiped first; the provider grant is revoked (best effort) only
   * when no other connection of this church still relies on the same grant.
   */
  async disconnect(actor: Actor, connectionId: string): Promise<void> {
    const result = await this.uow.runLocked(connectionsLock(actor.churchId), async () => {
      const connection = await this.connections.findById(actor.churchId, connectionId);
      if (!connection) throw notFound('Connection');
      if (connection.status === 'revoked') return null;
      const account = connection.encryptedAccessToken ? this.open(connection) : null;
      const grantId = grantIdOf(connection);
      const shared = grantId
        ? await this.connections.countConnectedByGrant(actor.churchId, grantId, connection.id)
        : 0;
      await this.connections.save({
        ...connection,
        status: 'revoked',
        encryptedAccessToken: null,
        encryptedRefreshToken: undefined,
        tokenExpiresAt: undefined,
        updatedAt: this.clock.now(),
      });
      await this.audit.record({
        churchId: actor.churchId,
        userId: actor.userId,
        action: 'connection.disconnected',
        connectionId,
        detail: { platform: connection.platform },
      });
      return shared === 0 && account ? { connection, account } : null;
    });
    if (!result) return;
    try {
      await this.registry.forProvider(result.connection.provider).revokeConnection(result.account);
    } catch (error) {
      this.logger.warn(
        {
          connectionId,
          provider: result.connection.provider,
          errorCode: error instanceof SocialProviderError ? error.code : 'UNKNOWN',
        },
        'Provider token revocation failed (local tokens already deleted)',
      );
    }
  }

  // ───────────── OAuth ─────────────

  async startAuthorization(
    actor: Actor,
    provider: SocialProviderId,
    options: { platforms?: SocialPlatform[]; reconnectConnectionId?: string } = {},
  ): Promise<{ authorizationUrl: string }> {
    const adapter = this.registry.forProvider(provider);
    if (!adapter.isConfigured()) throw providerNotConfigured();
    const supported = PLATFORMS_FOR_PROVIDER[provider];
    let platforms = options.platforms?.length ? options.platforms : [...supported];
    if (platforms.some((platform) => !supported.includes(platform)))
      throw validationError('platforms', `Not a ${provider} platform`);
    if (options.reconnectConnectionId) {
      const connection = await this.connections.findById(actor.churchId, options.reconnectConnectionId);
      if (!connection || connection.status === 'revoked') throw notFound('Connection');
      platforms = [connection.platform];
    }
    // Unguessable, single-use, short-lived; only its hash is stored. It binds the completion to
    // the church and user that started the flow.
    const { token: state, hash } = this.tokens.generate();
    const codeVerifier = this.tokens.generate().token;
    await this.cache.set<PendingAuthorization>(
      oauthStateKey(hash),
      {
        churchId: actor.churchId,
        userId: actor.userId,
        provider,
        platforms,
        codeVerifier,
        reconnectConnectionId: options.reconnectConnectionId,
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    return {
      authorizationUrl: await adapter.getAuthorizationUrl({
        state,
        redirectUri: this.settings.redirectUri(provider),
        platforms,
        codeVerifier,
      }),
    };
  }

  /** Starts a new grant for an existing account (the user signs in to the same account again). */
  async reconnect(actor: Actor, connectionId: string): Promise<{ authorizationUrl: string }> {
    const connection = (await this.list(actor.churchId)).find((entry) => entry.id === connectionId);
    if (!connection) throw notFound('Connection');
    return this.startAuthorization(actor, connection.provider, { reconnectConnectionId: connectionId });
  }

  /** Where the provider redirect is forwarded; the web app completes the flow from there. */
  forwardUrl(provider: SocialProviderId, input: { code?: string; state?: string; error?: string }): string {
    const query = new URLSearchParams({ provider });
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, value);
    return `${this.settings.webUrl}/social-accounts/callback?${query.toString()}`;
  }

  /**
   * Finishes an OAuth grant. A browser redirect from the provider carries no access token, so the
   * web app calls this itself with the code and state from the redirect. It needs the single-use
   * state AND the signed-in church and user that started the flow, so an authorisation link sent
   * to someone else connects nothing (CSRF / replay safe).
   */
  async completeAuthorization(
    provider: SocialProviderId,
    input: { code: string; state: string },
    caller: Actor,
  ): Promise<AuthorizationOutcome> {
    const pending = await this.cache.take<PendingAuthorization>(oauthStateKey(this.tokens.hash(input.state)));
    if (
      !pending ||
      pending.provider !== provider ||
      caller.churchId !== pending.churchId ||
      caller.userId !== pending.userId
    )
      throw invalidOAuthState();
    const actor: Actor = { churchId: pending.churchId, userId: pending.userId };

    let accounts: ConnectedAccount[];
    try {
      accounts = (
        await this.registry.forProvider(provider).exchangeAuthorizationCode({
          code: input.code,
          redirectUri: this.settings.redirectUri(provider),
          codeVerifier: pending.codeVerifier,
          platforms: pending.platforms,
        })
      ).accounts.filter((account) => pending.platforms.includes(account.platform));
    } catch (error) {
      this.logger.warn(
        {
          provider,
          churchId: actor.churchId,
          errorCode: error instanceof SocialProviderError ? error.code : 'UNKNOWN',
          providerRequestId: error instanceof SocialProviderError ? error.providerRequestId : undefined,
        },
        'Social OAuth exchange failed',
      );
      throw error instanceof SocialProviderError && error.code === 'PERMISSION_DENIED'
        ? noAccounts()
        : connectionFailed();
    }
    if (accounts.length === 0) throw noAccounts();
    const grantId = newId();

    if (pending.reconnectConnectionId) {
      const connection = await this.connections.findById(actor.churchId, pending.reconnectConnectionId);
      const match = accounts.find(
        (account) =>
          account.platform === connection?.platform && account.providerAccountId === connection.providerAccountId,
      );
      if (!connection || !match) throw accountMismatch();
      await this.persist(actor, provider, grantId, [match], true);
      return { provider, connectionId: connection.id };
    }
    if (accounts.length === 1) {
      const [connection] = await this.persist(actor, provider, grantId, accounts);
      return { provider, connectionId: connection?.id };
    }
    // Several Pages / channels / organisations: the user chooses before anything is stored.
    const selectionId = newId();
    await this.cache.set<PendingSelection>(
      selectionKey(selectionId),
      {
        churchId: actor.churchId,
        userId: actor.userId,
        provider,
        grantId,
        accounts: accounts.map((account, index) => ({
          ref: String(index),
          platform: account.platform,
          providerAccountId: account.providerAccountId,
          accountName: account.accountName,
          avatarUrl: account.avatarUrl,
          scopes: account.scopes,
          metadata: account.metadata,
          tokenExpiresAt: account.tokenExpiresAt?.toISOString(),
          sealedTokens: this.cipher.encrypt(
            JSON.stringify({ accessToken: account.accessToken, refreshToken: account.refreshToken }),
            `selection:${selectionId}`,
          ),
        })),
      },
      SELECTION_TTL_SECONDS,
    );
    return { provider, selectionId };
  }

  // ───────────── Account selection (multi-account grants) ─────────────

  /** Lists the accounts of a grant (never tokens). */
  async selectionAccounts(
    actor: Actor,
    selectionId: string,
  ): Promise<{ provider: SocialProviderId; accounts: PendingAccountView[] }> {
    const selection = this.ownSelection(actor, await this.cache.get<PendingSelection>(selectionKey(selectionId)));
    const existing = await this.connections.list(actor.churchId);
    return {
      provider: selection.provider,
      accounts: selection.accounts.map((account) => ({
        ref: account.ref,
        platform: account.platform,
        accountName: account.accountName,
        avatarUrl: account.avatarUrl ?? null,
        alreadyConnected: existing.some(
          (connection) =>
            connection.status === 'connected' &&
            connection.platform === account.platform &&
            connection.providerAccountId === account.providerAccountId,
        ),
      })),
    };
  }

  /** Single use: a valid choice consumes the selection; an invalid one leaves it for another try. */
  async confirmSelection(actor: Actor, selectionId: string, refs: string[]): Promise<SocialConnection[]> {
    const key = selectionKey(selectionId);
    const pending = this.ownSelection(actor, await this.cache.get<PendingSelection>(key));
    const valid = new Set(pending.accounts.map((account) => account.ref));
    if (refs.length === 0 || refs.some((ref) => !valid.has(ref)))
      throw validationError('accountRefs', 'Choose at least one of the listed accounts');
    // take() is atomic: of two concurrent confirmations only one gets the tokens.
    const selection = this.ownSelection(actor, await this.cache.take<PendingSelection>(key));
    const accounts: ConnectedAccount[] = selection.accounts
      .filter((account) => refs.includes(account.ref))
      .map((account) => {
        const tokens = JSON.parse(this.cipher.decrypt(account.sealedTokens, `selection:${selectionId}`)) as {
          accessToken: string;
          refreshToken?: string;
        };
        return {
          platform: account.platform,
          providerAccountId: account.providerAccountId,
          accountName: account.accountName,
          avatarUrl: account.avatarUrl,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: account.tokenExpiresAt ? new Date(account.tokenExpiresAt) : undefined,
          scopes: account.scopes,
          metadata: account.metadata,
        };
      });
    return this.persist(actor, selection.provider, selection.grantId, accounts);
  }

  // ───────────── Token access ─────────────

  /** Seals tokens for storage on `connection` (which must already have its final id). */
  seal(
    connection: Pick<SocialConnection, 'id' | 'churchId'>,
    tokens: { accessToken: string; refreshToken?: string },
  ): Pick<SocialConnection, 'encryptedAccessToken' | 'encryptedRefreshToken'> {
    return {
      encryptedAccessToken: this.cipher.encrypt(tokens.accessToken, tokenContext(connection, 'access')),
      encryptedRefreshToken: tokens.refreshToken
        ? this.cipher.encrypt(tokens.refreshToken, tokenContext(connection, 'refresh'))
        : undefined,
    };
  }

  /** Decrypts without any refresh (revocation, account capability lookups). */
  open(connection: SocialConnection): AuthorizedAccount {
    if (!connection.encryptedAccessToken)
      throw new SocialProviderError('AUTH_EXPIRED', `Connection ${connection.id} has no stored token`);
    return {
      connectionId: connection.id,
      churchId: connection.churchId,
      platform: connection.platform,
      providerAccountId: connection.providerAccountId,
      accountName: connection.accountName,
      scopes: connection.scopes,
      metadata: connection.metadata,
      accessToken: this.cipher.decrypt(connection.encryptedAccessToken, tokenContext(connection, 'access')),
      refreshToken: connection.encryptedRefreshToken
        ? this.cipher.decrypt(connection.encryptedRefreshToken, tokenContext(connection, 'refresh'))
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
      throw new SocialProviderError('AUTH_EXPIRED', `Connection ${connection.id} is ${connection.status}`);
    if (!needsRefresh(connection, this.clock.now())) return this.open(connection);
    return this.refresh(connection);
  }

  /**
   * Serialised per connection through a shared lock, because providers that rotate refresh tokens
   * (TikTok, X) invalidate the old one on use: two concurrent refreshes would lock the account out.
   * `proactive` (token maintenance) refreshes ahead of the publish-time margin; either way a
   * connection someone else refreshed meanwhile is returned as is.
   */
  async refresh(connection: SocialConnection, options: { proactive?: boolean } = {}): Promise<AuthorizedAccount> {
    const lock = refreshLockKey(connection.id);
    if (!(await this.cache.setIfAbsent(lock, 1, REFRESH_LOCK_TTL_SECONDS)))
      throw new SocialProviderError('PROVIDER_UNAVAILABLE', `Token refresh for ${connection.id} already in progress`, {
        retryable: true,
      });
    try {
      // Re-read under the lock: another worker may have refreshed it a moment ago.
      const current = await this.connections.findById(connection.churchId, connection.id);
      if (!current || current.status !== 'connected')
        throw new SocialProviderError('AUTH_EXPIRED', `Connection ${connection.id} is gone`);
      const refreshedMeanwhile = current.tokenExpiresAt?.getTime() !== connection.tokenExpiresAt?.getTime();
      if (refreshedMeanwhile || (!options.proactive && !needsRefresh(current, this.clock.now())))
        return this.open(current);
      const account = this.open(current);
      const adapter = this.registry.forProvider(current.provider);
      let refreshed;
      try {
        refreshed = await adapter.refreshConnection(account);
      } catch (error) {
        if (error instanceof SocialProviderError && error.code === 'AUTH_EXPIRED')
          await this.expire(current, 'refresh rejected');
        else this.observer.tokenRefresh({ provider: current.provider, outcome: 'failed' });
        throw error;
      }
      if (!refreshed) {
        // Cannot be refreshed (no refresh token): usable until it actually expires.
        if (current.tokenExpiresAt && current.tokenExpiresAt <= this.clock.now()) {
          await this.expire(current, 'token expired without refresh token');
          throw new SocialProviderError('AUTH_EXPIRED', `Connection ${current.id} expired`);
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
      this.observer.tokenRefresh({ provider: current.provider, outcome: 'refreshed' });
      return this.open(updated);
    } finally {
      await this.cache.del(lock);
    }
  }

  /** Marks the connection expired (the user must reconnect) and keeps no usable token. */
  async expire(connection: SocialConnection, reason: string): Promise<void> {
    if (connection.status !== 'connected') return;
    await this.connections.save({ ...connection, status: 'expired', updatedAt: this.clock.now() });
    this.observer.tokenRefresh({ provider: connection.provider, outcome: 'expired' });
    await this.audit.record({
      churchId: connection.churchId,
      action: 'connection.expired',
      connectionId: connection.id,
      detail: { platform: connection.platform, reason },
    });
    this.logger.log({ connectionId: connection.id, platform: connection.platform, reason }, 'Social connection expired');
  }

  // ───────────── Internals ─────────────

  /** Persists accounts from an OAuth grant: one connection per account, tokens sealed per row. */
  private async persist(
    actor: Actor,
    provider: SocialProviderId,
    grantId: string,
    accounts: ConnectedAccount[],
    reconnecting = false,
  ): Promise<SocialConnection[]> {
    return this.uow.runLocked(connectionsLock(actor.churchId), async () => {
      const saved: SocialConnection[] = [];
      for (const account of accounts) {
        const existing = await this.connections.findByAccount(actor.churchId, account.platform, account.providerAccountId);
        const now = this.clock.now();
        const base = { id: existing?.id ?? newId(), churchId: actor.churchId };
        const connection: SocialConnection = {
          ...base,
          platform: account.platform,
          provider,
          providerAccountId: account.providerAccountId,
          accountName: account.accountName,
          avatarUrl: account.avatarUrl,
          ...this.seal(base, account),
          tokenExpiresAt: account.tokenExpiresAt,
          scopes: account.scopes,
          status: 'connected',
          metadata: { ...account.metadata, grantId },
          connectedByUserId: actor.userId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await this.connections.save(connection);
        await this.audit.record({
          churchId: actor.churchId,
          userId: actor.userId,
          action: existing || reconnecting ? 'connection.reconnected' : 'connection.connected',
          connectionId: connection.id,
          detail: { platform: connection.platform, accountName: connection.accountName },
        });
        saved.push(connection);
      }
      return saved;
    });
  }

  /** A selection from another church or user is indistinguishable from an expired one. */
  private ownSelection(actor: Actor, selection: PendingSelection | null): PendingSelection {
    if (!selection || selection.churchId !== actor.churchId || selection.userId !== actor.userId)
      throw notFound('Account selection');
    return selection;
  }
}
