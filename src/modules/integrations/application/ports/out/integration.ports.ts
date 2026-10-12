import type {
  IntegrationProvider,
  IntegrationRecord,
} from '../../../domain/integration.js';

export const INTEGRATION_REPOSITORY = Symbol('INTEGRATION_REPOSITORY');

export interface IntegrationRepositoryPort {
  list(churchId: string): Promise<IntegrationRecord[]>;
  find(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationRecord | null>;
  upsert(record: IntegrationRecord): Promise<void>;
  setStatus(
    churchId: string,
    provider: IntegrationProvider,
    status: IntegrationRecord['status'],
  ): Promise<void>;
  delete(churchId: string, provider: IntegrationProvider): Promise<void>;
}

export interface OAuthConnection {
  credentials: Record<string, string>;
  externalAccountId: string | null;
  accountLabel: string | null;
  expiresAt: Date | null;
}

/** One adapter per provider; implementations own all provider-specific OAuth details. */
export interface OAuthProviderPort {
  readonly provider: IntegrationProvider;
  readonly configured: boolean;
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthConnection>;
}

export const OAUTH_PROVIDERS = Symbol('OAUTH_PROVIDERS');

export const INTEGRATION_SETTINGS = Symbol('INTEGRATION_SETTINGS');

export interface IntegrationSettings {
  webUrl: string;
  publicApiUrl: string;
}
