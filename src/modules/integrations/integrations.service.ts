import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { SECRET_BOX, type SecretBoxPort, TOKEN_GENERATOR, type TokenGeneratorPort } from '../../shared/application/ports/secret-box.port.js';
import { newId } from '../../shared/domain/id.js';
import { INTEGRATION_SETTINGS, OAUTH_PROVIDERS, type OAuthProviderPort } from './adapters/ports.js';
import {
  connectionFailed, INTEGRATION_PROVIDERS, type IntegrationProvider, type IntegrationSettings, type IntegrationView,
  integrationUnavailable, invalidOAuthState, OAUTH_STATE_TTL_SECONDS, type OAuthState, oauthStateKey, redirectUriFor,
  webCallbackUrl,
} from './helper.js';
import { INTEGRATION_REPOSITORY, type IntegrationRepositoryPort } from './integrations.repository.js';

/** Messaging and email connections, plus server-side credential access for the publishers. */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY) private readonly integrations: IntegrationRepositoryPort,
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProviderPort[],
    @Inject(SECRET_BOX) private readonly secrets: SecretBoxPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(INTEGRATION_SETTINGS) private readonly settings: IntegrationSettings,
  ) {}

  /** One row per supported provider, even when not connected. Secrets are never included. */
  async list(churchId: string): Promise<IntegrationView[]> {
    const rows = new Map((await this.integrations.list(churchId)).map((row) => [row.provider, row]));
    return INTEGRATION_PROVIDERS.map((provider) => {
      const row = rows.get(provider);
      return { provider, status: row?.status ?? 'NOT_CONNECTED', accountLabel: row?.accountLabel ?? null };
    });
  }

  async connect(churchId: string, provider: IntegrationProvider): Promise<{ authorizationUrl: string }> {
    const adapter = this.providers.find((candidate) => candidate.provider === provider);
    if (!adapter?.configured) throw integrationUnavailable();
    // Unguessable single-use state binds the callback to this church (CSRF protection for OAuth).
    const { token: state } = this.tokens.generate();
    await this.cache.set<OAuthState>(oauthStateKey(state), { churchId, provider }, OAUTH_STATE_TTL_SECONDS);
    return {
      authorizationUrl: adapter.authorizationUrl({ state, redirectUri: redirectUriFor(this.settings, provider) }),
    };
  }

  /** The URL the provider redirect is forwarded to; the web app completes the flow from there. */
  callbackRedirect(provider: IntegrationProvider, input: { code?: string; state?: string; error?: string }): string {
    return webCallbackUrl(this.settings, { provider, ...input });
  }

  /**
   * Finishes a connection started by `connect`. The caller must be signed in to the church that
   * started it; otherwise an attacker could send their authorisation link to someone else and
   * capture that person's mailing list under the attacker's church.
   */
  async complete(
    churchId: string,
    provider: IntegrationProvider,
    input: { code: string; state: string },
  ): Promise<IntegrationView> {
    const state = await this.cache.take<OAuthState>(oauthStateKey(input.state));
    if (!state || state.provider !== provider || state.churchId !== churchId) throw invalidOAuthState();
    const adapter = this.providers.find((candidate) => candidate.provider === provider);
    if (!adapter) throw integrationUnavailable();
    try {
      const connection = await adapter.exchange({ code: input.code, redirectUri: redirectUriFor(this.settings, provider) });
      const existing = await this.integrations.find(churchId, provider);
      await this.integrations.upsert({
        id: existing?.id ?? newId(),
        churchId,
        provider,
        status: 'CONNECTED',
        encryptedCredentials: this.secrets.seal(JSON.stringify(connection.credentials)),
        externalAccountId: connection.externalAccountId,
        accountLabel: connection.accountLabel,
        expiresAt: connection.expiresAt,
      });
      return { provider, status: 'CONNECTED', accountLabel: connection.accountLabel };
    } catch (error) {
      this.logger.warn({ provider, churchId, err: error }, 'OAuth exchange failed');
      throw connectionFailed();
    }
  }

  /** Idempotent: disconnecting a provider that is not connected succeeds. */
  async disconnect(churchId: string, provider: IntegrationProvider): Promise<void> {
    await this.integrations.delete(churchId, provider);
  }

  /** Decrypts the stored credentials on demand; null unless the integration is connected. */
  async credentialsFor(churchId: string, provider: IntegrationProvider): Promise<Record<string, string> | null> {
    const row = await this.integrations.find(churchId, provider);
    if (!row || row.status !== 'CONNECTED' || !row.encryptedCredentials) return null;
    return JSON.parse(this.secrets.open(row.encryptedCredentials)) as Record<string, string>;
  }

  async markNeedsAttention(churchId: string, provider: IntegrationProvider): Promise<void> {
    await this.integrations.setStatus(churchId, provider, 'NEEDS_ATTENTION');
  }
}
