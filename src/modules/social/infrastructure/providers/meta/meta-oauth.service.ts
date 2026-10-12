import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  ConnectedAccount,
} from '../../../application/ports/out/social-publishing.port.js';
import { SocialProviderError } from '../../../domain/social-errors.js';
import type { SocialPlatform } from '../../../domain/social-platform.js';
import type { MetaApiClient } from './meta-api.client.js';
import { toFacebookAccount, toInstagramAccount } from './meta.mapper.js';
import type { MetaConfig, MetaPage } from './meta.types.js';

/** Least privilege: only the scopes the requested platforms need (publishing + post metrics). */
const SCOPES: Record<'facebook' | 'instagram', string[]> = {
  facebook: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'read_insights',
  ],
  instagram: [
    'pages_show_list',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_insights',
  ],
};

/** Page roles that may publish. */
const PUBLISHING_TASKS = new Set(['CREATE_CONTENT', 'MANAGE']);

export class MetaOAuthService {
  constructor(
    private readonly config: MetaConfig,
    private readonly api: MetaApiClient,
  ) {}

  authorizationUrl(input: AuthorizationInput): string {
    const scopes = new Set(
      input.platforms.flatMap((platform) =>
        platform === 'facebook' || platform === 'instagram'
          ? SCOPES[platform]
          : [],
      ),
    );
    return `${this.api.dialogUrl}?${new URLSearchParams({
      client_id: this.config.appId ?? '',
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: 'code',
      scope: [...scopes].join(','),
    }).toString()}`;
  }

  /**
   * Code → short-lived user token → long-lived user token → Page tokens. Page tokens derived from
   * a long-lived user token do not expire, so Pages need no refresh (they stop working only if
   * the user removes the app or loses their Page role).
   */
  async exchange(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccount[]> {
    const shortLived = await this.api.post<{ access_token: string }>(
      'oauth.exchange_code',
      `${this.api.graphUrl}/oauth/access_token`,
      undefined,
      {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
      },
    );
    const longLived = await this.api.post<{ access_token: string }>(
      'oauth.long_lived_token',
      `${this.api.graphUrl}/oauth/access_token`,
      undefined,
      {
        grant_type: 'fb_exchange_token',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: shortLived.access_token,
      },
    );
    const userToken = longLived.access_token;
    const [pages, permissions] = await Promise.all([
      this.api.get<{ data: MetaPage[] }>(
        'oauth.list_pages',
        'me/accounts',
        userToken,
        {
          fields:
            'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
          limit: '100',
        },
      ),
      this.api.get<{ data: Array<{ permission: string; status: string }> }>(
        'oauth.permissions',
        'me/permissions',
        userToken,
      ),
    ]);
    const scopes = permissions.data
      .filter((entry) => entry.status === 'granted')
      .map((entry) => entry.permission);
    const wants = (platform: SocialPlatform) =>
      input.platforms.includes(platform);
    const accounts: ConnectedAccount[] = [];
    for (const page of pages.data) {
      if (!page.access_token) continue;
      if (page.tasks && !page.tasks.some((task) => PUBLISHING_TASKS.has(task)))
        continue;
      if (wants('facebook')) accounts.push(toFacebookAccount(page, scopes));
      if (wants('instagram') && page.instagram_business_account)
        accounts.push(toInstagramAccount(page, scopes));
    }
    if (accounts.length === 0)
      throw new SocialProviderError(
        'PERMISSION_DENIED',
        'No publishable Facebook Page or Instagram professional account was granted',
      );
    return accounts;
  }
}
