import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  ConnectedAccount,
  RefreshResult,
} from '../../ports.js';
import { SocialProviderError } from '../../../helper.js';
import type { AuthorizedAccount } from '../../../helper.js';
import {
  TIKTOK_AUTHORIZE_URL,
  type TikTokApiClient,
} from './tiktok-api.client.js';
import type {
  TikTokConfig,
  TikTokTokenResponse,
  TikTokUser,
} from './tiktok.types.js';

/**
 * Least privilege: profile basics (name, avatar, open_id) and Direct Post. `video.list` is not
 * requested, so post metrics are not offered (see `TikTokSocialAdapter`).
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;
const PUBLISH_SCOPE = 'video.publish';
const USER_FIELDS = 'open_id,union_id,avatar_url,display_name';

const splitScopes = (scope: string | undefined): string[] =>
  (scope ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const expiresAt = (
  seconds: number | undefined,
  now = Date.now(),
): Date | undefined =>
  typeof seconds === 'number' && seconds > 0
    ? new Date(now + seconds * 1000)
    : undefined;

/**
 * Login Kit for Web. TikTok's web flow uses a confidential client (client secret) and does not
 * take PKCE, so the verifier the port hands over is deliberately ignored.
 */
export class TikTokOAuthService {
  constructor(
    private readonly config: TikTokConfig,
    private readonly api: TikTokApiClient,
  ) {}

  authorizationUrl(input: AuthorizationInput): string {
    return `${TIKTOK_AUTHORIZE_URL}?${new URLSearchParams({
      client_key: this.config.clientKey ?? '',
      response_type: 'code',
      scope: TIKTOK_SCOPES.join(','),
      redirect_uri: input.redirectUri,
      state: input.state,
    }).toString()}`;
  }

  /** Code → user token (about 24 h) + rotating refresh token (about 365 days) → the one account. */
  async exchange(input: AuthorizationCallbackInput): Promise<ConnectedAccount> {
    const token = await this.api.oauth<TikTokTokenResponse>(
      'oauth.exchange_code',
      '/v2/oauth/token/',
      {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      },
    );
    const scopes = splitScopes(token.scope);
    // Users can untick scopes on TikTok's consent screen; without this one we cannot post.
    if (!scopes.includes(PUBLISH_SCOPE))
      throw new SocialProviderError(
        'PERMISSION_DENIED',
        `TikTok consent did not include ${PUBLISH_SCOPE}`,
      );
    const { user } = await this.api.get<{ user?: TikTokUser }>(
      'oauth.user_info',
      '/v2/user/info/',
      token.access_token,
      { fields: USER_FIELDS },
    );
    const openId = user?.open_id ?? token.open_id;
    const refreshExpiry = expiresAt(token.refresh_expires_in);
    return {
      platform: 'tiktok',
      providerAccountId: openId,
      accountName: user?.display_name || 'TikTok account',
      avatarUrl: user?.avatar_url,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: expiresAt(token.expires_in),
      scopes,
      metadata: {
        openId,
        unionId: user?.union_id ?? null,
        refreshTokenExpiresAt: refreshExpiry?.toISOString() ?? null,
      },
    };
  }

  /** TikTok may rotate the refresh token: the new one is always returned and must be stored. */
  async refresh(account: AuthorizedAccount): Promise<RefreshResult | null> {
    if (!account.refreshToken) return null;
    const token = await this.api.oauth<TikTokTokenResponse>(
      'oauth.refresh',
      '/v2/oauth/token/',
      {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
      },
    );
    const scopes = splitScopes(token.scope);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || undefined,
      tokenExpiresAt: expiresAt(token.expires_in),
      scopes: scopes.length > 0 ? scopes : undefined,
    };
  }

  /**
   * Best effort. A token TikTok already considers invalid counts as revoked; provider outages
   * are rethrown so the caller can log them (it deletes our copy of the token either way).
   */
  async revoke(account: AuthorizedAccount): Promise<void> {
    try {
      await this.api.oauth('oauth.revoke', '/v2/oauth/revoke/', {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        token: account.accessToken,
      });
    } catch (error) {
      if (
        error instanceof SocialProviderError &&
        (error.code === 'AUTH_EXPIRED' ||
          error.code === 'PERMISSION_DENIED' ||
          error.code === 'UNSUPPORTED_CONTENT')
      )
        return;
      throw error;
    }
  }
}
