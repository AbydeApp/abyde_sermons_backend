import type { ContentType } from '../../content/helper.js';
import type { IntegrationProvider } from '../helper.js';

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


export interface PublishInput {
  idempotencyKey: string;
  credentials: Record<string, string>;
  content: { type: ContentType; title: string; body: string };
}

export type PublishResult =
  | { ok: true; externalId: string }
  /** `definite` = the provider certainly did not publish (safe to retry); otherwise the outcome is unknown. */
  | {
      ok: false;
      retryable: boolean;
      definite: boolean;
      credentialsInvalid: boolean;
      message: string;
    };

export interface PublishingProviderPort {
  readonly provider: IntegrationProvider;
  publish(input: PublishInput): Promise<PublishResult>;
}

export const PUBLISHING_PROVIDERS = Symbol('PUBLISHING_PROVIDERS');
