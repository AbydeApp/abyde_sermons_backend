import type {
  AuthorizedAccount,
  PlatformCapabilities,
  SocialErrorCode,
  SocialPlatform,
  SocialProviderId,
} from '../helper.js';

export interface AuthorizationInput {
  /** Single-use, server-generated state; the adapter only passes it through. */
  state: string;
  redirectUri: string;
  /** Platforms the user is connecting, so scopes stay least-privilege. */
  platforms: readonly SocialPlatform[];
  /** PKCE verifier (43+ chars). Adapters whose provider supports PKCE send its S256 challenge. */
  codeVerifier: string;
}

export interface AuthorizationCallbackInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  platforms: readonly SocialPlatform[];
}

/** One publishable account found during the OAuth exchange (a Page, an IG account, a channel…). */
export interface ConnectedAccount {
  platform: SocialPlatform;
  providerAccountId: string;
  accountName: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes: string[];
  /** Non-secret details needed to publish later (organisation URN, IG user id…). */
  metadata: Record<string, unknown>;
}

export interface ConnectedAccounts {
  accounts: ConnectedAccount[];
}

export interface RefreshResult {
  accessToken: string;
  /** Providers that rotate refresh tokens return the new one; absent = keep the current one. */
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string[];
}

export interface PublishMedia {
  type: 'image' | 'video';
  /** URL the provider fetches (signed or public delivery URL of generated media only). */
  url: string;
  /** Storage key, for adapters that must upload bytes themselves (YouTube, X, LinkedIn). */
  objectKey: string;
  mimeType: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface PublishInput {
  platform: SocialPlatform;
  account: AuthorizedAccount;
  /** Publication id: correlates provider calls and logs. */
  idempotencyKey: string;
  text?: string;
  title?: string;
  media: PublishMedia[];
  thumbnail?: PublishMedia;
  /** Validated per-target settings (privacy level, tags…). */
  settings: Record<string, unknown>;
  /** Aborts the provider calls (job time limit or shutdown). */
  signal?: AbortSignal;
}

/**
 * Result of a publish step. Failures are thrown as SocialProviderError, which says whether the
 * provider may have published (`outcome`) and whether retrying is safe (`retryable`).
 */
export type PublishOutcome =
  | {
      status: 'published';
      providerPostId: string;
      permalink?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      /** The provider is still working (container processing, async upload…). Check again later. */
      status: 'processing';
      providerRef: string;
      checkAfterSeconds: number;
      /** Non-secret state the next check needs. */
      metadata?: Record<string, unknown>;
    };

export interface CheckPublicationInput extends PublishInput {
  providerRef: string;
  providerMetadata: Record<string, unknown>;
}

export interface DeletePostInput {
  platform: SocialPlatform;
  account: AuthorizedAccount;
  providerPostId: string;
  signal?: AbortSignal;
}

export interface MetricsInput {
  platform: SocialPlatform;
  account: AuthorizedAccount;
  providerPostId: string;
  signal?: AbortSignal;
}

/** Normalised counters; a provider fills what it reports. */
export interface PostMetrics {
  views?: number;
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

/** Account-specific limits (TikTok returns them per creator). */
export interface AccountCapabilities {
  platform: SocialPlatform;
  /** Allowed privacy options for this account, when the provider restricts them. */
  privacyLevels?: string[];
  maxVideoDurationSeconds?: number;
  commentsDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  canPost: boolean;
  restrictions: string[];
}

/**
 * One adapter per provider. Provider-specific logic (endpoints, versions, scopes, media workflows,
 * error codes) lives behind this port; use cases only see the normalised shapes above.
 */
export interface SocialPublishingPort {
  readonly provider: SocialProviderId;
  readonly platforms: readonly SocialPlatform[];
  /** Server credentials for this provider are present. */
  isConfigured(): boolean;

  getAuthorizationUrl(input: AuthorizationInput): Promise<string>;
  exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccounts>;
  /** Null when the token does not expire or cannot be refreshed (the caller then asks to reconnect). */
  refreshConnection(account: AuthorizedAccount): Promise<RefreshResult | null>;
  /** Best effort; revoking an already invalid token succeeds. */
  revokeConnection(account: AuthorizedAccount): Promise<void>;

  getCapabilities(): Promise<PlatformCapabilities[]>;
  getAccountCapabilities?(
    account: AuthorizedAccount,
  ): Promise<AccountCapabilities>;

  publish(input: PublishInput): Promise<PublishOutcome>;
  /** Continues a `processing` publication (and may perform the final publish step). */
  checkPublication?(input: CheckPublicationInput): Promise<PublishOutcome>;
  delete?(input: DeletePostInput): Promise<void>;
  getMetrics?(input: MetricsInput): Promise<PostMetrics>;
}

export const SOCIAL_PROVIDER_REGISTRY = Symbol('SOCIAL_PROVIDER_REGISTRY');

export interface SocialProviderRegistryPort {
  forPlatform(platform: SocialPlatform): SocialPublishingPort;
  forProvider(provider: SocialProviderId): SocialPublishingPort;
  all(): readonly SocialPublishingPort[];
}

export const SOCIAL_TOKEN_CIPHER = Symbol('SOCIAL_TOKEN_CIPHER');

/**
 * Authenticated encryption for provider tokens at rest. `context` is bound into the ciphertext
 * (associated data), so a token copied to another connection or church cannot be decrypted there.
 * Keys live in the secret store, never in the database.
 */
export interface TokenCipherPort {
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}

export const SOCIAL_MEDIA_LIBRARY = Symbol('SOCIAL_MEDIA_LIBRARY');

export interface PublishableAsset {
  id: string;
  kind: 'IMAGE' | 'CAROUSEL_SLIDE' | 'VIDEO' | 'THUMBNAIL' | 'BRAND_LOGO';
  status: 'PENDING' | 'READY' | 'FAILED';
  objectKey: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** Generated media a post may carry (never original sermon uploads). */
export interface SocialMediaLibraryPort {
  findAssets(churchId: string, ids: string[]): Promise<PublishableAsset[]>;
  /** URL the provider can fetch for `ttlSeconds`. */
  deliveryUrl(objectKey: string, ttlSeconds: number): Promise<string>;
}

export const SOCIAL_SETTINGS = Symbol('SOCIAL_SETTINGS');

export interface SocialSettings {
  webUrl: string;
  /** OAuth redirect URI registered with each provider. */
  redirectUri(provider: SocialProviderId): string;
  mediaUrlTtlSeconds: number;
}

export const SOCIAL_OBSERVER = Symbol('SOCIAL_OBSERVER');

/** Metrics hook for the publishing pipeline, implemented by the observability layer. */
export interface SocialObserverPort {
  providerCall(event: {
    provider: SocialProviderId;
    operation: string;
    durationMs: number;
    outcome: 'success' | 'failure';
    errorCode?: SocialErrorCode;
  }): void;
  publication(event: {
    platform: SocialPlatform;
    outcome: 'published' | 'failed' | 'processing' | 'retry';
    errorCode?: SocialErrorCode;
    /** From queueing to the outcome. */
    latencyMs?: number;
  }): void;
  tokenRefresh(event: {
    provider: SocialProviderId;
    outcome: 'refreshed' | 'expired' | 'failed';
  }): void;
}
