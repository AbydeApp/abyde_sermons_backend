import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  SECRET_BOX,
  type SecretBoxPort,
  TOKEN_GENERATOR,
  type TokenGeneratorPort,
} from '../../../../shared/application/ports/secret-box.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  type IntegrationStatus,
} from '../../domain/integration.js';
import {
  INTEGRATION_REPOSITORY,
  INTEGRATION_SETTINGS,
  type IntegrationRepositoryPort,
  type IntegrationSettings,
  OAUTH_PROVIDERS,
  type OAuthProviderPort,
} from '../ports/out/integration.ports.js';

export interface IntegrationView {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  accountLabel: string | null;
}

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `oauth-state:${state}`;

interface OAuthState {
  churchId: string;
  provider: IntegrationProvider;
}

const redirectUriFor = (
  settings: IntegrationSettings,
  provider: IntegrationProvider,
) => `${settings.publicApiUrl}/integrations/${provider.toLowerCase()}/callback`;

@Injectable()
export class ListIntegrationsUseCase {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepositoryPort,
  ) {}

  /** One row per supported provider, even when not connected. Secrets are never included. */
  async execute(churchId: string): Promise<IntegrationView[]> {
    const rows = new Map(
      (await this.integrations.list(churchId)).map((row) => [
        row.provider,
        row,
      ]),
    );
    return INTEGRATION_PROVIDERS.map((provider) => {
      const row = rows.get(provider);
      return {
        provider,
        status: row?.status ?? 'NOT_CONNECTED',
        accountLabel: row?.accountLabel ?? null,
      };
    });
  }
}

@Injectable()
export class ConnectIntegrationUseCase {
  constructor(
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProviderPort[],
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(INTEGRATION_SETTINGS)
    private readonly settings: IntegrationSettings,
  ) {}

  async execute(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<{ authorizationUrl: string }> {
    const adapter = this.providers.find(
      (candidate) => candidate.provider === provider,
    );
    if (!adapter?.configured) {
      throw new DomainError(
        'UNAVAILABLE',
        'INTEGRATION_UNAVAILABLE',
        'This integration is not available yet.',
      );
    }
    // Unguessable single-use state binds the callback to this church (CSRF protection for OAuth).
    const { token: state } = this.tokens.generate();
    await this.cache.set<OAuthState>(
      stateKey(state),
      { churchId, provider },
      STATE_TTL_SECONDS,
    );
    return {
      authorizationUrl: adapter.authorizationUrl({
        state,
        redirectUri: redirectUriFor(this.settings, provider),
      }),
    };
  }
}

@Injectable()
export class CompleteOAuthUseCase {
  private readonly logger = new Logger(CompleteOAuthUseCase.name);

  constructor(
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProviderPort[],
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepositoryPort,
    @Inject(SECRET_BOX) private readonly secrets: SecretBoxPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(INTEGRATION_SETTINGS)
    private readonly settings: IntegrationSettings,
  ) {}

  /** Returns the web URL to redirect the browser to. Never throws to the browser. */
  async execute(
    provider: IntegrationProvider,
    input: { code?: string; state?: string; error?: string },
    callerChurchId: string | null,
  ): Promise<string> {
    const back = (params: string) =>
      `${this.settings.webUrl}/integrations?${params}`;
    if (!input.state) return back('error=invalid_state');
    const state = await this.cache.take<OAuthState>(stateKey(input.state));
    if (!state || state.provider !== provider)
      return back('error=invalid_state');
    // The browser finishing the flow must be signed in to the church that started it. Otherwise
    // an attacker could send their authorisation link to someone else and capture that person's
    // page or mailing list under the attacker's church.
    if (callerChurchId !== state.churchId) return back('error=invalid_session');
    if (input.error || !input.code)
      return back(`error=access_denied&provider=${provider}`);
    const adapter = this.providers.find(
      (candidate) => candidate.provider === provider,
    );
    if (!adapter) return back('error=unavailable');
    try {
      const connection = await adapter.exchange({
        code: input.code,
        redirectUri: redirectUriFor(this.settings, provider),
      });
      const existing = await this.integrations.find(state.churchId, provider);
      await this.integrations.upsert({
        id: existing?.id ?? newId(),
        churchId: state.churchId,
        provider,
        status: 'CONNECTED',
        encryptedCredentials: this.secrets.seal(
          JSON.stringify(connection.credentials),
        ),
        externalAccountId: connection.externalAccountId,
        accountLabel: connection.accountLabel,
        expiresAt: connection.expiresAt,
      });
      return back(`connected=${provider}`);
    } catch (error) {
      this.logger.warn(
        { provider, churchId: state.churchId, err: error },
        'OAuth exchange failed',
      );
      return back(`error=connection_failed&provider=${provider}`);
    }
  }
}

@Injectable()
export class DisconnectIntegrationUseCase {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepositoryPort,
  ) {}

  /** Idempotent: disconnecting a provider that is not connected succeeds. */
  async execute(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<void> {
    await this.integrations.delete(churchId, provider);
  }
}

/** Server-side credential access for publishing adapters (decrypts on demand). */
@Injectable()
export class IntegrationCredentialsService {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepositoryPort,
    @Inject(SECRET_BOX) private readonly secrets: SecretBoxPort,
  ) {}

  async credentialsFor(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<Record<string, string> | null> {
    const row = await this.integrations.find(churchId, provider);
    if (!row || row.status !== 'CONNECTED' || !row.encryptedCredentials)
      return null;
    return JSON.parse(this.secrets.open(row.encryptedCredentials)) as Record<
      string,
      string
    >;
  }

  async markNeedsAttention(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<void> {
    await this.integrations.setStatus(churchId, provider, 'NEEDS_ATTENTION');
  }
}
