import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  ConnectedAccount,
  RefreshResult,
} from '../../ports.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import { pkceChallenge } from '../shared/pkce.js';
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  type YouTubeApiClient,
} from './youtube-api.client.js';
import type {
  GoogleTokenResponse,
  YouTubeChannel,
  YouTubeConfig,
  YouTubeList,
} from './youtube.types.js';

export const YOUTUBE_UPLOAD_SCOPE =
  'https://www.googleapis.com/auth/youtube.upload';
/** Channel discovery and video statistics; cannot change anything on the channel. */
export const YOUTUBE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/youtube.readonly';
/** Least privilege: upload (which also covers `thumbnails.set`) + read-only. */
const SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE];
/**
 * Scopes `videos.delete` needs. They grant full management of the channel, so we never request
 * them; a connection only has one if the user granted it to our client elsewhere
 * (`include_granted_scopes`). See `YouTubeSocialAdapter.delete`.
 */
export const YOUTUBE_MANAGE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/**
 * Google OAuth 2.0 (web server flow with PKCE). Access tokens last about an hour; the refresh
 * token from the offline grant keeps the connection alive until the user revokes the app.
 */
export class GoogleOAuthService {
  constructor(
    private readonly config: YouTubeConfig,
    private readonly api: YouTubeApiClient,
  ) {}

  authorizationUrl(input: AuthorizationInput): string {
    return `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      // A refresh token, and `consent` so Google issues one again on a reconnect.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString()}`;
  }

  /** Code → tokens → the YouTube channel(s) the chosen Google identity owns. */
  async exchange(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccount[]> {
    const tokens = await this.api.postForm<GoogleTokenResponse>(
      'oauth.exchange_code',
      GOOGLE_TOKEN_URL,
      {
        code: input.code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      },
    );
    const scopes = tokens.scope?.split(' ').filter(Boolean) ?? SCOPES;
    // Granular consent lets the user untick a scope; without upload there is nothing to connect.
    if (!scopes.includes(YOUTUBE_UPLOAD_SCOPE))
      throw new SocialProviderError(
        'PERMISSION_DENIED',
        'The YouTube upload permission was not granted',
      );
    const channels = await this.api.get<YouTubeList<YouTubeChannel>>(
      'oauth.list_channels',
      'channels',
      tokens.access_token,
      { part: 'snippet', mine: 'true' },
    );
    const items = channels.items ?? [];
    if (items.length === 0)
      throw new SocialProviderError(
        'PERMISSION_DENIED',
        'The Google account has no YouTube channel',
      );
    const tokenExpiresAt = expiresAt(tokens.expires_in);
    return items.map((channel) => ({
      platform: 'youtube',
      providerAccountId: channel.id,
      accountName: channel.snippet?.title ?? channel.id,
      avatarUrl: channel.snippet?.thumbnails?.default?.url,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt,
      scopes,
      metadata: {
        channelId: channel.id,
        customUrl: channel.snippet?.customUrl ?? null,
      },
    }));
  }

  /** Null without a refresh token (the caller asks the user to reconnect once the token lapses). */
  async refresh(account: AuthorizedAccount): Promise<RefreshResult | null> {
    if (!account.refreshToken) return null;
    const tokens = await this.api.postForm<GoogleTokenResponse>(
      'oauth.refresh',
      GOOGLE_TOKEN_URL,
      {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      },
    );
    return {
      accessToken: tokens.access_token,
      // Google rarely rotates refresh tokens; absent means "keep the current one".
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt(tokens.expires_in),
      scopes: tokens.scope?.split(' ').filter(Boolean),
    };
  }

  /**
   * Revoking the refresh token ends the whole grant (and its access tokens). A token Google no
   * longer knows (`invalid_token`) is already revoked, which is what we wanted.
   */
  async revoke(account: AuthorizedAccount): Promise<void> {
    try {
      await this.api.postForm('oauth.revoke', GOOGLE_REVOKE_URL, {
        token: account.refreshToken ?? account.accessToken,
      });
    } catch (error) {
      if (
        error instanceof SocialProviderError &&
        error.httpStatus === 400 &&
        error.code === 'AUTH_EXPIRED'
      )
        return;
      throw error;
    }
  }
}

const expiresAt = (seconds: number | undefined): Date | undefined =>
  seconds ? new Date(Date.now() + seconds * 1000) : undefined;
