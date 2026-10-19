import type {
  OAuthConnection,
  OAuthProviderPort,
} from './ports.js';

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `OAuth request to ${new URL(url).host} failed (${response.status})`,
    );
  return (await response.json()) as T;
}

const query = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

interface MetaConfig {
  appId?: string;
  appSecret?: string;
  graphVersion: string;
}

/** WhatsApp Business (Meta). Stored for future broadcast support; V1 WhatsApp content is shared manually. */
export class WhatsAppOAuthProvider implements OAuthProviderPort {
  readonly provider = 'WHATSAPP' as const;

  constructor(private readonly config: MetaConfig) {}

  get configured(): boolean {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://www.facebook.com/${this.config.graphVersion}/dialog/oauth?${query(
      {
        client_id: this.config.appId ?? '',
        redirect_uri: input.redirectUri,
        state: input.state,
        scope: 'whatsapp_business_management,whatsapp_business_messaging',
      },
    )}`;
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthConnection> {
    const graph = `https://graph.facebook.com/${this.config.graphVersion}`;
    const token = await getJson<{ access_token: string; expires_in?: number }>(
      `${graph}/oauth/access_token?${query({ client_id: this.config.appId ?? '', client_secret: this.config.appSecret ?? '', redirect_uri: input.redirectUri, code: input.code })}`,
    );
    const me = await getJson<{ id: string; name?: string }>(
      `${graph}/me?${query({ fields: 'id,name', access_token: token.access_token })}`,
    );
    return {
      credentials: { accessToken: token.access_token },
      externalAccountId: me.id,
      accountLabel: me.name ?? 'WhatsApp Business',
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : null,
    };
  }
}

/** Mailchimp: newsletters are sent as campaigns to the account's default audience. */
export class MailchimpOAuthProvider implements OAuthProviderPort {
  readonly provider = 'EMAIL' as const;

  constructor(
    private readonly config: { clientId?: string; clientSecret?: string },
  ) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://login.mailchimp.com/oauth2/authorize?${query({ response_type: 'code', client_id: this.config.clientId ?? '', redirect_uri: input.redirectUri, state: input.state })}`;
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthConnection> {
    const token = await getJson<{ access_token: string }>(
      'https://login.mailchimp.com/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: query({
          grant_type: 'authorization_code',
          client_id: this.config.clientId ?? '',
          client_secret: this.config.clientSecret ?? '',
          redirect_uri: input.redirectUri,
          code: input.code,
        }),
      },
    );
    const metadata = await getJson<{
      api_endpoint: string;
      accountname: string;
      user_id?: number;
    }>('https://login.mailchimp.com/oauth2/metadata', {
      headers: { Authorization: `OAuth ${token.access_token}` },
    });
    const lists = await getJson<{ lists: Array<{ id: string; name: string }> }>(
      `${metadata.api_endpoint}/3.0/lists?count=1`,
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    );
    const list = lists.lists[0];
    if (!list) throw new Error('Mailchimp account has no audience');
    return {
      credentials: {
        accessToken: token.access_token,
        apiEndpoint: metadata.api_endpoint,
        listId: list.id,
      },
      externalAccountId: metadata.user_id ? String(metadata.user_id) : null,
      accountLabel: `${metadata.accountname} · ${list.name}`,
      expiresAt: null,
    };
  }
}
