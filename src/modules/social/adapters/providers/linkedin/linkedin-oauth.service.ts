import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  ConnectedAccount,
  RefreshResult,
} from '../../ports.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import type { LinkedInApiClient } from './linkedin-api.client.js';
import type {
  LinkedInConfig,
  LinkedInOrganization,
  LinkedInOrganizationAcl,
  LinkedInTokenResponse,
} from './linkedin.types.js';

/** Sign-in (OIDC) + posting as the member. */
const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'];
/** Community Management API: list administered Pages and post as them. */
const ORGANIZATION_SCOPES = [
  'r_organization_social',
  'w_organization_social',
  'rw_organization_admin',
];
/** Pages offered per connection; more than this is not a realistic church setup. */
const MAX_ORGANIZATIONS = 50;

const ORGANIZATION_URN = /^urn:li:organization:(\d+)$/;

export class LinkedInOAuthService {
  constructor(
    private readonly config: LinkedInConfig,
    private readonly api: LinkedInApiClient,
  ) {}

  /** LinkedIn does not support PKCE for confidential web apps, so the verifier is not sent. */
  authorizationUrl(input: AuthorizationInput): string {
    const scopes = this.config.organizations
      ? [...MEMBER_SCOPES, ...ORGANIZATION_SCOPES]
      : MEMBER_SCOPES;
    return `${this.api.authorizationUrl}?${new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      state: input.state,
      scope: scopes.join(' '),
    }).toString()}`;
  }

  /**
   * Code → member token → the member's own profile, plus (with Community Management access) every
   * Page they administer. All accounts share the member token: LinkedIn has no per-Page tokens.
   */
  async exchange(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccount[]> {
    const token = await this.api.token('oauth.exchange_code', {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });
    const grant = toGrant(token);
    const profile = await this.api.userInfo(token.access_token);
    if (!profile.sub)
      throw new SocialProviderError(
        'UNKNOWN',
        'LinkedIn userinfo returned no member id',
      );
    const personUrn = `urn:li:person:${profile.sub}`;
    const accounts: ConnectedAccount[] = [
      {
        platform: 'linkedin',
        providerAccountId: personUrn,
        accountName:
          profile.name ??
          ([profile.given_name, profile.family_name]
            .filter(Boolean)
            .join(' ') ||
            'LinkedIn member'),
        avatarUrl: profile.picture,
        ...grant,
        metadata: { ...grant.metadata, authorUrn: personUrn, kind: 'person' },
      },
    ];
    if (this.config.organizations) {
      for (const organization of await this.administeredOrganizations(
        token.access_token,
      )) {
        accounts.push({
          platform: 'linkedin',
          providerAccountId: organization.urn,
          accountName: organization.name,
          ...grant,
          metadata: {
            ...grant.metadata,
            authorUrn: organization.urn,
            kind: 'organization',
          },
        });
      }
    }
    return accounts;
  }

  /** Programmatic refresh tokens exist only for approved partners; without one the user reconnects. */
  async refresh(account: AuthorizedAccount): Promise<RefreshResult | null> {
    if (!account.refreshToken) return null;
    const token = await this.api.token('oauth.refresh', {
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
    });
    const grant = toGrant(token);
    return {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      tokenExpiresAt: grant.tokenExpiresAt,
      scopes: grant.scopes.length > 0 ? grant.scopes : undefined,
    };
  }

  /**
   * Pages where the member is an approved ADMINISTRATOR. A 403 means the member (or app) lacks
   * organisation access: the personal profile is still connected, just without Pages.
   */
  private async administeredOrganizations(
    token: string,
  ): Promise<Array<{ urn: string; name: string }>> {
    let acls: LinkedInOrganizationAcl[];
    try {
      acls =
        (
          await this.api.get<{ elements?: LinkedInOrganizationAcl[] }>(
            'oauth.organization_acls',
            `organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=${MAX_ORGANIZATIONS}`,
            token,
          )
        ).elements ?? [];
    } catch (error) {
      if (
        error instanceof SocialProviderError &&
        error.code === 'PERMISSION_DENIED'
      )
        return [];
      throw error;
    }
    const urns = [
      ...new Set(
        acls
          .filter((acl) => (acl.state ?? 'APPROVED') === 'APPROVED')
          .map((acl) => acl.organizationTarget ?? acl.organization)
          .filter(
            (urn): urn is string =>
              typeof urn === 'string' && ORGANIZATION_URN.test(urn),
          ),
      ),
    ].slice(0, MAX_ORGANIZATIONS);
    return Promise.all(
      urns.map(async (urn) => ({
        urn,
        name: await this.organizationName(urn, token),
      })),
    );
  }

  /** The Page name is cosmetic: a failed lookup falls back to a neutral label. */
  private async organizationName(urn: string, token: string): Promise<string> {
    const id = ORGANIZATION_URN.exec(urn)?.[1] ?? '';
    try {
      const organization = await this.api.get<LinkedInOrganization>(
        'oauth.organization',
        `organizations/${id}`,
        token,
      );
      return organization.localizedName ?? `LinkedIn Page ${id}`;
    } catch (error) {
      if (error instanceof SocialProviderError && error.code === 'AUTH_EXPIRED')
        throw error;
      return `LinkedIn Page ${id}`;
    }
  }
}

function toGrant(
  token: LinkedInTokenResponse,
): Pick<
  ConnectedAccount,
  'accessToken' | 'refreshToken' | 'tokenExpiresAt' | 'scopes'
> & { metadata: Record<string, unknown> } {
  const now = Date.now();
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || undefined,
    tokenExpiresAt: token.expires_in
      ? new Date(now + token.expires_in * 1000)
      : undefined,
    scopes: (token.scope ?? '').split(/[\s,]+/).filter(Boolean),
    // Non-secret: lets the UI warn before the refresh token itself lapses.
    metadata: token.refresh_token_expires_in
      ? {
          refreshTokenExpiresAt: new Date(
            now + token.refresh_token_expires_in * 1000,
          ).toISOString(),
        }
      : {},
  };
}
