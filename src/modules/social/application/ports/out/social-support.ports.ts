import type { SocialErrorCode } from '../../../domain/social-errors.js';
import type {
  SocialPlatform,
  SocialProviderId,
} from '../../../domain/social-platform.js';

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
