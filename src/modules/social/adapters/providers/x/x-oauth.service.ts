import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  ConnectedAccount,
  RefreshResult,
} from '../../ports.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import { pkceChallenge } from '../shared/pkce.js';
import { basicAuth, type XApiClient, X_ENDPOINTS } from './x-api.client.js';
import type { XConfig, XTokenResponse, XUser } from './x.types.js';

/**
 * Least privilege for posting with media and reading post metrics. `offline.access` is what makes
 * X issue a refresh token (access tokens last two hours); `media.write` is required by the v2
 * media upload endpoints.
 */
export const X_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
  'media.write',
] as const;

/** Without these the connection could not publish, so connecting would only fail later. */
const REQUIRED_SCOPES = ['tweet.write', 'media.write', 'users.read'];

/**
 * OAuth 2.0 Authorization Code + PKCE as a confidential client: the token and revoke endpoints
 * authenticate the app with HTTP Basic (client id:secret); the PKCE verifier proves the callback
 * belongs to the browser session that started the flow.
 */
export class XOAuthService {
  constructor(
    private readonly config: XConfig,
    private readonly api: XApiClient,
  ) {}

  authorizationUrl(input: AuthorizationInput): string {
    return `${X_ENDPOINTS.authorize}?${new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      scope: X_SCOPES.join(' '),
      state: input.state,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString()}`;
  }

  async exchange(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccount[]> {
    const tokens = await this.api.postForm<XTokenResponse>(
      'oauth.exchange_code',
      X_ENDPOINTS.token,
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      },
      { headers: this.clientAuth() },
    );
    const scopes = parseScopes(tokens.scope);
    const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    if (scopes.length > 0 && missing.length > 0)
      throw new SocialProviderError(
        'PERMISSION_DENIED',
        `X grant is missing scopes: ${missing.join(', ')}`,
      );
    const me = await this.api.get<{ data: XUser }>(
      'oauth.me',
      X_ENDPOINTS.me,
      tokens.access_token,
      { 'user.fields': 'profile_image_url,username,name' },
    );
    const user = me.data;
    return [
      {
        platform: 'x',
        providerAccountId: user.id,
        accountName: `@${user.username}`,
        avatarUrl: user.profile_image_url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt(tokens.expires_in),
        scopes: scopes.length > 0 ? scopes : [...X_SCOPES],
        // `username` builds permalinks without an extra API call at publish time.
        metadata: { userId: user.id, username: user.username },
      },
    ];
  }

  /**
   * X rotates refresh tokens: the response carries a new one and the old one stops working, so
   * the caller must persist it. A rejected refresh token (invalid_grant/invalid_request) maps to
   * AUTH_EXPIRED and the user reconnects.
   */
  async refresh(account: AuthorizedAccount): Promise<RefreshResult | null> {
    if (!account.refreshToken) return null;
    const tokens = await this.api.postForm<XTokenResponse>(
      'oauth.refresh',
      X_ENDPOINTS.token,
      { grant_type: 'refresh_token', refresh_token: account.refreshToken },
      { headers: this.clientAuth() },
    );
    const scopes = parseScopes(tokens.scope);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt(tokens.expires_in),
      scopes: scopes.length > 0 ? scopes : undefined,
    };
  }

  /** Best effort: revoking the refresh token ends the grant; the access token is revoked too. */
  async revoke(account: AuthorizedAccount): Promise<void> {
    const tokens: Array<
      [string | undefined, 'refresh_token' | 'access_token']
    > = [
      [account.refreshToken, 'refresh_token'],
      [account.accessToken, 'access_token'],
    ];
    for (const [token, hint] of tokens) {
      if (!token) continue;
      try {
        await this.api.postForm(
          'oauth.revoke',
          X_ENDPOINTS.revoke,
          { token, token_type_hint: hint },
          { headers: this.clientAuth() },
        );
      } catch {
        // Already invalid or X unavailable: disconnecting still deletes our stored tokens.
        // The failure is already counted by the HTTP client's metrics.
      }
    }
  }

  private clientAuth(): Record<string, string> {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret)
      throw new SocialProviderError(
        'UNKNOWN',
        'X OAuth client credentials are not configured',
        {
          retryable: false,
        },
      );
    return basicAuth(clientId, clientSecret);
  }
}

const parseScopes = (scope: string | undefined): string[] =>
  scope ? scope.split(/\s+/).filter(Boolean) : [];

const expiresAt = (seconds: number | undefined): Date | undefined =>
  seconds ? new Date(Date.now() + seconds * 1000) : undefined;
