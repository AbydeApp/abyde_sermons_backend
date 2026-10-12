import type { SocialPlatform, SocialProviderId } from './social-platform.js';

export const CONNECTION_STATUSES = [
  'connected',
  'expired',
  'revoked',
  'error',
] as const;
export type SocialConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface SocialConnection {
  id: string;
  churchId: string;
  platform: SocialPlatform;
  provider: SocialProviderId;
  providerAccountId: string;
  accountName: string;
  avatarUrl?: string;
  /** Sealed with the token cipher; null once the connection is revoked. */
  encryptedAccessToken: string | null;
  encryptedRefreshToken?: string;
  tokenExpiresAt?: Date;
  scopes: string[];
  status: SocialConnectionStatus;
  /**
   * Non-secret provider details (page category, organisation URN…). `grantId` groups connections
   * created by one OAuth consent, which share a token at the provider.
   */
  metadata: Record<string, unknown>;
  connectedByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A connection with its tokens decrypted just in time. Never persisted, logged or returned. */
export interface AuthorizedAccount {
  connectionId: string;
  churchId: string;
  platform: SocialPlatform;
  providerAccountId: string;
  accountName: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
}

/** Refresh this long before expiry so a publish never starts with a token about to lapse. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const needsRefresh = (
  connection: Pick<SocialConnection, 'tokenExpiresAt'>,
  now: Date,
): boolean =>
  connection.tokenExpiresAt !== undefined &&
  connection.tokenExpiresAt.getTime() - now.getTime() < TOKEN_REFRESH_MARGIN_MS;

export const grantIdOf = (connection: Pick<SocialConnection, 'metadata'>) =>
  typeof connection.metadata.grantId === 'string'
    ? connection.metadata.grantId
    : undefined;
