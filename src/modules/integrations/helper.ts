import { z } from 'zod';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { DomainError, notFound } from '../../shared/domain/domain-error.js';
import type { ContentType } from '../content/helper.js';

// ───────────────────────── Providers ─────────────────────────

/** Messaging and email. Social platforms (Facebook, YouTube, ...) are connected in the social module. */
export const INTEGRATION_PROVIDERS = ['WHATSAPP', 'EMAIL'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'NEEDS_ATTENTION';

export interface IntegrationRecord {
  id: string;
  churchId: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** Sealed (encrypted) credential blob; never leaves the server. */
  encryptedCredentials: string | null;
  externalAccountId: string | null;
  accountLabel: string | null;
  expiresAt: Date | null;
}

export const isIntegrationProvider = (value: string): value is IntegrationProvider =>
  (INTEGRATION_PROVIDERS as readonly string[]).includes(value);

/** Parses the `:provider` path segment; unknown providers are a 404. */
export const providerFrom = (raw: string): IntegrationProvider => {
  const provider = raw.toUpperCase();
  if (!isIntegrationProvider(provider)) throw notFound('Integration');
  return provider;
};

export interface IntegrationView {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  accountLabel: string | null;
}

// ───────────────────────── OAuth ─────────────────────────

export const OAUTH_STATE_TTL_SECONDS = 600;
export const oauthStateKey = (state: string) => `oauth-state:${state}`;

export interface OAuthState {
  churchId: string;
  provider: IntegrationProvider;
}

export interface IntegrationSettings {
  webUrl: string;
  publicApiUrl: string;
}

export const redirectUriFor = (settings: IntegrationSettings, provider: IntegrationProvider) =>
  `${settings.publicApiUrl}/integrations/${provider.toLowerCase()}/callback`;

/**
 * Where the provider redirect is forwarded. A browser redirect carries no access token, so the web
 * app finishes the flow itself with `POST /integrations/:provider/complete`.
 */
export const webCallbackUrl = (settings: IntegrationSettings, params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return `${settings.webUrl}/integrations/callback?${query.toString()}`;
};

export const invalidOAuthState = () =>
  new DomainError(
    'UNPROCESSABLE',
    'INVALID_OAUTH_STATE',
    'This connection link is invalid or has expired. Start again.',
  );

export const connectionFailed = () =>
  new DomainError('UNAVAILABLE', 'CONNECTION_FAILED', 'We could not complete the connection. Please try again.');

export const integrationUnavailable = () =>
  new DomainError('UNAVAILABLE', 'INTEGRATION_UNAVAILABLE', 'This integration is not available yet.');

export const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

export const CompleteBody = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(256),
});

// ───────────────────────── Publishing ─────────────────────────

/**
 * Where each content type is published automatically. `null` means the calendar is a plan only
 * (shared manually, or posted through Social Accounts) and the dispatcher leaves it alone.
 */
export const CHANNEL_FOR_TYPE: Record<ContentType, IntegrationProvider | null> = {
  DEVOTIONAL: null,
  SOCIAL_POST: null,
  QUOTE: null,
  PRAYER: null,
  EMAIL: 'EMAIL',
  BIBLE_STUDY: 'EMAIL',
  WHATSAPP: null,
  VIDEO_IDEA: null,
};

export const AUTO_PUBLISHED_TYPES = (Object.keys(CHANNEL_FOR_TYPE) as ContentType[]).filter(
  (type) => CHANNEL_FOR_TYPE[type] !== null,
);

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Mailchimp',
};

export interface PublishJobPayload {
  churchId: string;
  calendarItemId: string;
  contentItemId: string;
  scheduledAt: string;
}

export const PUBLISH_JOB = { queue: QUEUES.PUBLISHING, name: 'publish' } as const;
export const DISPATCH_JOB = { queue: QUEUES.PUBLISHING, name: 'dispatch-due' } as const;
export const DISPATCH_EVERY_MS = 60_000;
export const DISPATCH_BATCH = 100;
export const STALE_PUBLISHING_MS = 30 * 60 * 1000;

export type PublishAttemptStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface PublishAttemptRecord {
  id: string;
  churchId: string;
  contentItemId: string;
  provider: IntegrationProvider;
  idempotencyKey: string;
  status: PublishAttemptStatus;
  externalId: string | null;
  errorMessage: string | null;
  updatedAt: Date;
}

export interface DueItem {
  calendarItemId: string;
  churchId: string;
  contentItemId: string;
  scheduledAt: Date;
}

export const unconfirmedMessage = (provider: IntegrationProvider) =>
  `We couldn't confirm whether this was posted. Check ${PROVIDER_LABELS[provider]} before scheduling it again.`;
export const connectMessage = (provider: IntegrationProvider) =>
  `Connect ${PROVIDER_LABELS[provider]} to publish this automatically.`;
export const reconnectMessage = (provider: IntegrationProvider) =>
  `Reconnect ${PROVIDER_LABELS[provider]} and reschedule.`;
export const rejectedMessage = (provider: IntegrationProvider) =>
  `${PROVIDER_LABELS[provider]} rejected this post.`;
export const MANUAL_TYPE_MESSAGE = 'This content type is shared manually.';
