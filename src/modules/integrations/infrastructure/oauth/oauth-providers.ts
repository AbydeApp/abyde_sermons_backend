import type {
  OAuthConnection,
  OAuthProviderPort,
} from '../../application/ports/out/integration.ports.js';

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

/** Facebook Page publishing: exchanges for a long-lived user token, then stores the Page token. */
export class MetaOAuthProvider implements OAuthProviderPort {
  readonly provider = 'META' as const;

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
        scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
      },
    )}`;
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthConnection> {
    const graph = `https://graph.facebook.com/${this.config.graphVersion}`;
    const shortLived = await getJson<{ access_token: string }>(
      `${graph}/oauth/access_token?${query({ client_id: this.config.appId ?? '', client_secret: this.config.appSecret ?? '', redirect_uri: input.redirectUri, code: input.code })}`,
    );
    const longLived = await getJson<{ access_token: string }>(
      `${graph}/oauth/access_token?${query({ grant_type: 'fb_exchange_token', client_id: this.config.appId ?? '', client_secret: this.config.appSecret ?? '', fb_exchange_token: shortLived.access_token })}`,
    );
    const pages = await getJson<{
      data: Array<{ id: string; name: string; access_token: string }>;
    }>(
      `${graph}/me/accounts?${query({ fields: 'id,name,access_token', access_token: longLived.access_token })}`,
    );
    const page = pages.data[0];
    if (!page) throw new Error('No Facebook Page available for this account');
    return {
      credentials: { pageId: page.id, pageAccessToken: page.access_token },
      externalAccountId: page.id,
      accountLabel: page.name,
      expiresAt: null,
    };
  }
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

/** YouTube channel link (read-only scope) for future video publishing and metrics. */
export class YouTubeOAuthProvider implements OAuthProviderPort {
  readonly provider = 'YOUTUBE' as const;

  constructor(
    private readonly config: { clientId?: string; clientSecret?: string },
  ) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://accounts.google.com/o/oauth2/v2/auth?${query({
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: input.state,
    })}`;
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthConnection> {
    const token = await getJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: query({
        code: input.code,
        client_id: this.config.clientId ?? '',
        client_secret: this.config.clientSecret ?? '',
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const channels = await getJson<{
      items?: Array<{ id: string; snippet: { title: string } }>;
    }>(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    const channel = channels.items?.[0];
    return {
      credentials: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? '',
      },
      externalAccountId: channel?.id ?? null,
      accountLabel: channel?.snippet.title ?? 'YouTube channel',
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    };
  }
}
