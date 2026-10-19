import type { PublishInput } from '../../ports.js';
import type { SocialProviderError } from '../../../helper.js';
import { MetaSocialAdapter } from './meta-social.adapter.js';

const observer = {
  providerCall: () => undefined,
  publication: () => undefined,
  tokenRefresh: () => undefined,
};
const adapter = () =>
  new MetaSocialAdapter(
    {
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v21.0',
      timeoutMs: 1000,
    },
    observer,
  );

interface Call {
  url: string;
  method: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

/** Routes fetch calls by "METHOD path" substring; records every call. */
function stubGraph(routes: Array<[string, number, object]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = Object.fromEntries(
        new URLSearchParams(
          typeof init.body === 'string'
            ? init.body
            : (init.body?.toString() ?? ''),
        ),
      );
      calls.push({
        url,
        method,
        body,
        headers: init.headers as Record<string, string>,
      });
      const route = routes.find(([match]) =>
        `${method} ${url} ${new URLSearchParams(body).toString()}`.includes(
          match,
        ),
      );
      if (!route) throw new Error(`Unexpected call ${method} ${url}`);
      return new Response(JSON.stringify(route[2]), { status: route[1] });
    }),
  );
  return calls;
}

const account = (platform: 'facebook' | 'instagram') => ({
  connectionId: 'conn',
  churchId: 'c1',
  platform,
  providerAccountId: platform === 'facebook' ? 'page1' : 'ig1',
  accountName: 'Grace',
  scopes: [],
  metadata: { pageId: 'page1', igUserId: 'ig1' },
  accessToken: 'PAGE-TOKEN',
});

const input = (
  platform: 'facebook' | 'instagram',
  media: PublishInput['media'] = [],
): PublishInput => ({
  platform,
  account: account(platform),
  idempotencyKey: 'pub1',
  text: 'Faith over fear',
  media,
  settings: {},
});
const image = (n: number) => ({
  type: 'image' as const,
  url: `https://cdn.example/${n}.jpg`,
  objectKey: `k${n}`,
  mimeType: 'image/jpeg',
});

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: SocialProviderError) => error,
  );

describe('MetaSocialAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests only the scopes of the platforms being connected', async () => {
    const url = new URL(
      await adapter().getAuthorizationUrl({
        state: 'st',
        redirectUri: 'https://api/cb',
        platforms: ['facebook'],
        codeVerifier: 'v',
      }),
    );
    expect(url.pathname).toBe('/v21.0/dialog/oauth');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(url.searchParams.get('scope')).not.toContain(
      'instagram_content_publish',
    );
  });

  it('exchanges the code for Page and Instagram accounts the user can publish to', async () => {
    const calls = stubGraph([
      ['fb_exchange_token', 200, { access_token: 'LONG' }],
      ['oauth/access_token', 200, { access_token: 'SHORT' }],
      [
        'me/accounts',
        200,
        {
          data: [
            {
              id: 'page1',
              name: 'Grace',
              access_token: 'PT1',
              tasks: ['CREATE_CONTENT'],
              instagram_business_account: { id: 'ig1', username: 'grace' },
            },
            {
              id: 'page2',
              name: 'Read only',
              access_token: 'PT2',
              tasks: ['ANALYZE'],
            },
          ],
        },
      ],
      [
        'me/permissions',
        200,
        {
          data: [
            { permission: 'pages_manage_posts', status: 'granted' },
            { permission: 'x', status: 'declined' },
          ],
        },
      ],
    ]);
    const { accounts } = await adapter().exchangeAuthorizationCode({
      code: 'code',
      redirectUri: 'https://api/cb',
      codeVerifier: 'v',
      platforms: ['facebook', 'instagram'],
    });
    expect(
      accounts.map((a) => [
        a.platform,
        a.providerAccountId,
        a.accountName,
        a.accessToken,
      ]),
    ).toEqual([
      ['facebook', 'page1', 'Grace', 'PT1'],
      ['instagram', 'ig1', '@grace', 'PT1'],
    ]);
    expect(accounts[0]?.scopes).toEqual(['pages_manage_posts']);
    // Secrets travel in POST bodies or headers, never in URLs.
    expect(
      calls.every(
        (call) => !call.url.includes('secret') && !call.url.includes('LONG'),
      ),
    ).toBe(true);
    expect(
      calls.find((call) => call.url.includes('me/accounts'))?.headers
        .Authorization,
    ).toBe('Bearer LONG');
  });

  it('publishes a Facebook multi-photo post: unpublished photos first, then one decisive feed post', async () => {
    const calls = stubGraph([
      [
        'POST https://graph.facebook.com/v21.0/page1/photos',
        200,
        { id: 'photo' },
      ],
      [
        'POST https://graph.facebook.com/v21.0/page1/feed',
        200,
        { id: 'page1_post9' },
      ],
    ]);
    expect(
      await adapter().publish(input('facebook', [image(1), image(2)])),
    ).toEqual({
      status: 'published',
      providerPostId: 'page1_post9',
      permalink: 'https://www.facebook.com/page1_post9',
    });
    expect(
      calls
        .filter((call) => call.url.endsWith('/photos'))
        .every((call) => call.body.published === 'false'),
    ).toBe(true);
    expect(calls.at(-1)?.body).toMatchObject({
      message: 'Faith over fear',
      'attached_media[1]': '{"media_fbid":"photo"}',
    });
  });

  it('publishes an Instagram carousel: children, container, status check, media_publish', async () => {
    const calls = stubGraph([
      [
        'POST https://graph.facebook.com/v21.0/ig1/media_publish',
        200,
        { id: 'media9' },
      ],
      [
        'POST https://graph.facebook.com/v21.0/ig1/media',
        200,
        { id: 'container' },
      ],
      [
        'GET https://graph.facebook.com/v21.0/container',
        200,
        { status_code: 'FINISHED' },
      ],
      [
        'GET https://graph.facebook.com/v21.0/media9',
        200,
        { permalink: 'https://instagram.com/p/x' },
      ],
    ]);
    expect(
      await adapter().publish(
        input('instagram', [image(1), image(2), image(3)]),
      ),
    ).toEqual({
      status: 'published',
      providerPostId: 'media9',
      permalink: 'https://instagram.com/p/x',
    });
    const media = calls.filter((call) => call.url.endsWith('/ig1/media'));
    expect(media).toHaveLength(4);
    expect(
      media.slice(0, 3).every((call) => call.body.is_carousel_item === 'true'),
    ).toBe(true);
    expect(media[3]?.body).toMatchObject({
      media_type: 'CAROUSEL',
      children: 'container,container,container',
    });
  });

  it('leaves processing containers and reels to status checks instead of waiting', async () => {
    stubGraph([
      ['POST https://graph.facebook.com/v21.0/ig1/media', 200, { id: 'reel1' }],
    ]);
    const video = {
      type: 'video' as const,
      url: 'https://cdn/v.mp4',
      objectKey: 'v',
      mimeType: 'video/mp4',
    };
    expect(await adapter().publish(input('instagram', [video]))).toMatchObject({
      status: 'processing',
      providerRef: 'reel1',
    });
    stubGraph([
      [
        'GET https://graph.facebook.com/v21.0/reel1',
        200,
        { status_code: 'IN_PROGRESS' },
      ],
    ]);
    expect(
      await adapter().checkPublication({
        ...input('instagram', [video]),
        providerRef: 'reel1',
        providerMetadata: {},
      }),
    ).toMatchObject({ status: 'processing' });
    stubGraph([
      [
        'GET https://graph.facebook.com/v21.0/reel1',
        200,
        { status_code: 'ERROR', status: 'bad codec' },
      ],
    ]);
    const error = await rejection(
      adapter().checkPublication({
        ...input('instagram', [video]),
        providerRef: 'reel1',
        providerMetadata: {},
      }),
    );
    expect(error).toMatchObject({
      code: 'INVALID_MEDIA',
      outcome: 'not_published',
    });
  });

  it('maps Graph errors to normalised codes and outcomes', async () => {
    const graphError = (status: number, code: number, subcode?: number) =>
      stubGraph([
        [
          'POST',
          status,
          {
            error: {
              message: 'm',
              type: 'OAuthException',
              code,
              error_subcode: subcode,
              fbtrace_id: 'trace1',
            },
          },
        ],
      ]);
    graphError(400, 190);
    expect(await rejection(adapter().publish(input('facebook')))).toMatchObject(
      {
        code: 'AUTH_EXPIRED',
        providerRequestId: 'trace1',
      },
    );
    graphError(400, 4);
    expect(await rejection(adapter().publish(input('facebook')))).toMatchObject(
      { code: 'RATE_LIMITED', retryable: true },
    );
    graphError(403, 200);
    expect(await rejection(adapter().publish(input('facebook')))).toMatchObject(
      { code: 'PERMISSION_DENIED' },
    );
    graphError(400, 9007, 2207027);
    expect(
      await rejection(adapter().publish(input('instagram', [image(1)]))),
    ).toMatchObject({
      code: 'PROVIDER_PROCESSING',
      retryable: true,
    });
    graphError(500, 2);
    // A 5xx on the decisive feed post: it may have gone out, so never retried.
    expect(await rejection(adapter().publish(input('facebook')))).toMatchObject(
      {
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'unknown',
        retryable: false,
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await rejection(adapter().publish(input('facebook')))).toMatchObject(
      { outcome: 'unknown' },
    );
    expect(
      await rejection(adapter().publish(input('instagram', [image(1)]))),
    ).toMatchObject({
      outcome: 'not_published',
      retryable: true,
    });
  });

  it('reports capabilities from configuration', async () => {
    const unconfigured = new MetaSocialAdapter(
      { graphVersion: 'v21.0', timeoutMs: 1000 },
      observer,
    );
    const capabilities = await unconfigured.getCapabilities();
    expect(
      capabilities.map((entry) => [
        entry.platform,
        entry.configured,
        entry.textOnly,
      ]),
    ).toEqual([
      ['facebook', false, true],
      ['instagram', false, false],
    ]);
    expect(capabilities[1]?.imageContentTypes).toEqual(['image/jpeg']);
  });
});
