import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  TOKEN_GENERATOR,
  type TokenGeneratorPort,
} from '../../../../shared/application/ports/secret-box.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  DomainError,
  notFound,
  validationError,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type { PlatformCapabilities } from '../../domain/capabilities.js';
import {
  grantIdOf,
  type SocialConnection,
} from '../../domain/social-connection.js';
import { SocialProviderError } from '../../domain/social-errors.js';
import {
  PLATFORMS_FOR_PROVIDER,
  type SocialPlatform,
  type SocialProviderId,
} from '../../domain/social-platform.js';
import { ConnectionAccessService } from '../connection-access.service.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  type SocialAuditLogPort,
  type SocialConnectionRepositoryPort,
} from '../ports/out/social-repositories.port.js';
import {
  type AccountCapabilities,
  type ConnectedAccount,
  SOCIAL_PROVIDER_REGISTRY,
  type SocialProviderRegistryPort,
} from '../ports/out/social-publishing.port.js';
import {
  SOCIAL_SETTINGS,
  SOCIAL_TOKEN_CIPHER,
  type SocialSettings,
  type TokenCipherPort,
} from '../ports/out/social-support.ports.js';

const STATE_TTL_SECONDS = 600;
const SELECTION_TTL_SECONDS = 600;
const stateKey = (hash: string) => `social:oauth-state:${hash}`;
const selectionKey = (id: string) => `social:oauth-selection:${id}`;
const connectionsLock = (churchId: string) => `social-connections:${churchId}`;

export interface Actor {
  churchId: string;
  userId: string;
}

/** Server-side OAuth state: who started the flow, for what, and the PKCE verifier. */
interface PendingAuthorization {
  churchId: string;
  userId: string;
  provider: SocialProviderId;
  platforms: SocialPlatform[];
  codeVerifier: string;
  reconnectConnectionId?: string;
}

interface PendingAccount {
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
interface PendingSelection {
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

@Injectable()
export class ListSocialConnectionsUseCase {
  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
  ) {}

  /** Revoked connections are history, not accounts: they are not listed. */
  async execute(churchId: string): Promise<SocialConnection[]> {
    return (await this.connections.list(churchId)).filter(
      (connection) => connection.status !== 'revoked',
    );
  }
}

@Injectable()
export class StartSocialAuthorizationUseCase {
  constructor(
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(SOCIAL_SETTINGS) private readonly settings: SocialSettings,
  ) {}

  async execute(
    actor: Actor,
    provider: SocialProviderId,
    options: {
      platforms?: SocialPlatform[];
      reconnectConnectionId?: string;
    } = {},
  ): Promise<{ authorizationUrl: string }> {
    const adapter = this.registry.forProvider(provider);
    if (!adapter.isConfigured())
      throw new DomainError(
        'UNAVAILABLE',
        'PROVIDER_NOT_CONFIGURED',
        'This platform is not available yet.',
      );
    const supported = PLATFORMS_FOR_PROVIDER[provider];
    let platforms = options.platforms?.length
      ? options.platforms
      : [...supported];
    if (platforms.some((platform) => !supported.includes(platform)))
      throw validationError('platforms', `Not a ${provider} platform`);
    if (options.reconnectConnectionId) {
      const connection = await this.connections.findById(
        actor.churchId,
        options.reconnectConnectionId,
      );
      if (!connection || connection.status === 'revoked')
        throw notFound('Connection');
      platforms = [connection.platform];
    }
    // Unguessable, single-use, short-lived; only its hash is stored. It binds the callback to the
    // church and user that started the flow.
    const { token: state, hash } = this.tokens.generate();
    const codeVerifier = this.tokens.generate().token;
    await this.cache.set<PendingAuthorization>(
      stateKey(hash),
      {
        churchId: actor.churchId,
        userId: actor.userId,
        provider,
        platforms,
        codeVerifier,
        reconnectConnectionId: options.reconnectConnectionId,
      },
      STATE_TTL_SECONDS,
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
}

/** Persists accounts from an OAuth grant: one connection per account, tokens sealed per row. */
@Injectable()
export class ConnectionWriter {
  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async persist(
    actor: Actor,
    provider: SocialProviderId,
    grantId: string,
    accounts: ConnectedAccount[],
    reconnecting = false,
  ): Promise<SocialConnection[]> {
    return this.uow.runLocked(connectionsLock(actor.churchId), async () => {
      const saved: SocialConnection[] = [];
      for (const account of accounts) {
        const existing = await this.connections.findByAccount(
          actor.churchId,
          account.platform,
          account.providerAccountId,
        );
        const now = this.clock.now();
        const base = {
          id: existing?.id ?? newId(),
          churchId: actor.churchId,
        };
        const connection: SocialConnection = {
          ...base,
          platform: account.platform,
          provider,
          providerAccountId: account.providerAccountId,
          accountName: account.accountName,
          avatarUrl: account.avatarUrl,
          ...this.access.seal(base, account),
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
          action:
            existing || reconnecting
              ? 'connection.reconnected'
              : 'connection.connected',
          connectionId: connection.id,
          detail: {
            platform: connection.platform,
            accountName: connection.accountName,
          },
        });
        saved.push(connection);
      }
      return saved;
    });
  }
}

/**
 * OAuth callback. Never throws to the browser: every outcome is a redirect to the web app.
 * Requires the single-use state AND a session for the same church and user that started the
 * flow, so an authorisation link sent to someone else connects nothing (CSRF / replay safe).
 */
@Injectable()
export class CompleteSocialAuthorizationUseCase {
  private readonly logger = new Logger(CompleteSocialAuthorizationUseCase.name);

  constructor(
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(ConnectionWriter) private readonly writer: ConnectionWriter,
    @Inject(SOCIAL_TOKEN_CIPHER) private readonly cipher: TokenCipherPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(SOCIAL_SETTINGS) private readonly settings: SocialSettings,
  ) {}

  async execute(
    provider: SocialProviderId,
    input: { code?: string; state?: string; error?: string },
    caller: Actor | null,
  ): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.settings.webUrl}/social/connections?${new URLSearchParams({ provider, ...params }).toString()}`;
    if (!input.state) return back({ error: 'invalid_state' });
    const pending = await this.cache.take<PendingAuthorization>(
      stateKey(this.tokens.hash(input.state)),
    );
    if (!pending || pending.provider !== provider)
      return back({ error: 'invalid_state' });
    if (
      caller?.churchId !== pending.churchId ||
      caller.userId !== pending.userId
    )
      return back({ error: 'invalid_session' });
    if (input.error || !input.code) return back({ error: 'access_denied' });
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
      ).accounts.filter((account) =>
        pending.platforms.includes(account.platform),
      );
    } catch (error) {
      this.logger.warn(
        {
          provider,
          churchId: actor.churchId,
          errorCode:
            error instanceof SocialProviderError ? error.code : 'UNKNOWN',
          providerRequestId:
            error instanceof SocialProviderError
              ? error.providerRequestId
              : undefined,
        },
        'Social OAuth exchange failed',
      );
      return back({
        error:
          error instanceof SocialProviderError &&
          error.code === 'PERMISSION_DENIED'
            ? 'no_accounts'
            : 'connection_failed',
      });
    }
    if (accounts.length === 0) return back({ error: 'no_accounts' });
    const grantId = newId();

    if (pending.reconnectConnectionId) {
      const connection = await this.connections.findById(
        actor.churchId,
        pending.reconnectConnectionId,
      );
      const match = accounts.find(
        (account) =>
          account.platform === connection?.platform &&
          account.providerAccountId === connection.providerAccountId,
      );
      if (!connection || !match) return back({ error: 'account_mismatch' });
      await this.writer.persist(actor, provider, grantId, [match], true);
      return back({ connected: connection.id });
    }
    if (accounts.length === 1) {
      const [connection] = await this.writer.persist(
        actor,
        provider,
        grantId,
        accounts,
      );
      return back({ connected: connection?.id ?? '' });
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
            JSON.stringify({
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
            }),
            `selection:${selectionId}`,
          ),
        })),
      },
      SELECTION_TTL_SECONDS,
    );
    return back({ selection: selectionId });
  }
}

/** The secure selection step: lists accounts from a grant (no tokens) and persists the chosen ones. */
@Injectable()
export class SocialAccountSelectionUseCase {
  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(ConnectionWriter) private readonly writer: ConnectionWriter,
    @Inject(SOCIAL_TOKEN_CIPHER) private readonly cipher: TokenCipherPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async list(
    actor: Actor,
    selectionId: string,
  ): Promise<{ provider: SocialProviderId; accounts: PendingAccountView[] }> {
    const selection = this.own(
      actor,
      await this.cache.get<PendingSelection>(selectionKey(selectionId)),
    );
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
  async confirm(
    actor: Actor,
    selectionId: string,
    refs: string[],
  ): Promise<SocialConnection[]> {
    const key = selectionKey(selectionId);
    const pending = this.own(
      actor,
      await this.cache.get<PendingSelection>(key),
    );
    const valid = new Set(pending.accounts.map((account) => account.ref));
    if (refs.length === 0 || refs.some((ref) => !valid.has(ref)))
      throw validationError(
        'accountRefs',
        'Choose at least one of the listed accounts',
      );
    // take() is atomic: of two concurrent confirmations only one gets the tokens.
    const selection = this.own(
      actor,
      await this.cache.take<PendingSelection>(key),
    );
    const chosen = selection.accounts.filter((account) =>
      refs.includes(account.ref),
    );
    const accounts: ConnectedAccount[] = chosen.map((account) => {
      const tokens = JSON.parse(
        this.cipher.decrypt(account.sealedTokens, `selection:${selectionId}`),
      ) as { accessToken: string; refreshToken?: string };
      return {
        platform: account.platform,
        providerAccountId: account.providerAccountId,
        accountName: account.accountName,
        avatarUrl: account.avatarUrl,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: account.tokenExpiresAt
          ? new Date(account.tokenExpiresAt)
          : undefined,
        scopes: account.scopes,
        metadata: account.metadata,
      };
    });
    return this.writer.persist(
      actor,
      selection.provider,
      selection.grantId,
      accounts,
    );
  }

  /** A selection from another church or user is indistinguishable from an expired one. */
  private own(
    actor: Actor,
    selection: PendingSelection | null,
  ): PendingSelection {
    if (
      !selection ||
      selection.churchId !== actor.churchId ||
      selection.userId !== actor.userId
    )
      throw notFound('Account selection');
    return selection;
  }
}

@Injectable()
export class DisconnectSocialConnectionUseCase {
  private readonly logger = new Logger(DisconnectSocialConnectionUseCase.name);

  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
    @Inject(SOCIAL_AUDIT_LOG) private readonly audit: SocialAuditLogPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Idempotent. Stored tokens are wiped first; the provider grant is revoked (best effort) only
   * when no other connection of this church still relies on the same grant.
   */
  async execute(actor: Actor, connectionId: string): Promise<void> {
    const result = await this.uow.runLocked(
      connectionsLock(actor.churchId),
      async () => {
        const connection = await this.connections.findById(
          actor.churchId,
          connectionId,
        );
        if (!connection) throw notFound('Connection');
        if (connection.status === 'revoked') return null;
        const account = connection.encryptedAccessToken
          ? this.access.open(connection)
          : null;
        const grantId = grantIdOf(connection);
        const shared = grantId
          ? await this.connections.countConnectedByGrant(
              actor.churchId,
              grantId,
              connection.id,
            )
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
      },
    );
    if (!result) return;
    try {
      await this.registry
        .forProvider(result.connection.provider)
        .revokeConnection(result.account);
    } catch (error) {
      this.logger.warn(
        {
          connectionId,
          provider: result.connection.provider,
          errorCode:
            error instanceof SocialProviderError ? error.code : 'UNKNOWN',
        },
        'Provider token revocation failed (local tokens already deleted)',
      );
    }
  }
}

@Injectable()
export class GetSocialCapabilitiesUseCase {
  constructor(
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
  ) {}

  async execute(): Promise<PlatformCapabilities[]> {
    return (
      await Promise.all(
        this.registry.all().map((adapter) => adapter.getCapabilities()),
      )
    ).flat();
  }
}

@Injectable()
export class GetConnectionCapabilitiesUseCase {
  constructor(
    @Inject(SOCIAL_CONNECTION_REPOSITORY)
    private readonly connections: SocialConnectionRepositoryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
    @Inject(ConnectionAccessService)
    private readonly access: ConnectionAccessService,
  ) {}

  /** Account-specific limits (e.g. a TikTok creator's privacy options and maximum duration). */
  async execute(
    churchId: string,
    connectionId: string,
  ): Promise<AccountCapabilities> {
    const connection = await this.connections.findById(churchId, connectionId);
    if (!connection || connection.status === 'revoked')
      throw notFound('Connection');
    const adapter = this.registry.forPlatform(connection.platform);
    if (!adapter.getAccountCapabilities || connection.status !== 'connected')
      return {
        platform: connection.platform,
        canPost: connection.status === 'connected',
        restrictions:
          connection.status === 'connected'
            ? []
            : ['Reconnect this account to publish.'],
      };
    try {
      return await adapter.getAccountCapabilities(
        await this.access.authorize(connection),
      );
    } catch (error) {
      if (error instanceof SocialProviderError && error.code === 'AUTH_EXPIRED')
        return {
          platform: connection.platform,
          canPost: false,
          restrictions: ['Reconnect this account to publish.'],
        };
      throw new DomainError(
        'UNAVAILABLE',
        'PROVIDER_UNAVAILABLE',
        'The platform did not respond. Try again shortly.',
      );
    }
  }
}
