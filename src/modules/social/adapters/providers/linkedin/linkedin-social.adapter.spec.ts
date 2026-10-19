import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoragePort } from '../../../../../shared/application/ports/storage.port.js';
import type { SocialObserverPort } from '../../ports.js';
import type { PublishInput } from '../../ports.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import { MediaFiles } from '../shared/media-download.js';
import {
  escapeLittleText,
  LinkedInSocialAdapter,
} from './linkedin-social.adapter.js';
import type { LinkedInConfig } from './linkedin.types.js';

// ───────────── test doubles ─────────────

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bytes?: Buffer;
}
type Responder = (call: Call) => Response;

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Routes by `METHOD url-fragment`; the first unused matching route answers. Records every call. */
function stubLinkedIn(routes: Array<[string, Responder]>) {
  const calls: Call[] = [];
  const used = new Set<number>();
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    let body: unknown;
    let bytes: Buffer | undefined;
    if (init.body instanceof URLSearchParams)
      body = Object.fromEntries(init.body);
    else if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body)
      bytes = Buffer.from(await new Response(init.body).arrayBuffer());
    const call: Call = {
      method,
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      bytes,
    };
    calls.push(call);
    const index = routes.findIndex(([key], i) => {
      const [routeMethod, fragment = ''] = key.split(' ');
      return !used.has(i) && routeMethod === method && url.includes(fragment);
    });
    if (index < 0) throw new Error(`Unexpected ${method} ${url}`);
    used.add(index);
    return routes[index]![1](call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const objects = new Map<string, Buffer>();
const storage = {
  downloadToFile: async (key: string, path: string) =>
    writeFile(path, objects.get(key) ?? Buffer.alloc(0)),
} as unknown as StoragePort;
const scratch = {
  withDirectory: async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-spec-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
const observer: SocialObserverPort = {
  providerCall: vi.fn(),
  publication: vi.fn(),
  tokenRefresh: vi.fn(),
};

const config = (overrides: Partial<LinkedInConfig> = {}): LinkedInConfig => ({
  clientId: 'client-id',
  clientSecret: 'client-secret',
  timeoutMs: 5_000,
  apiVersion: '202609',
  organizations: false,
  ...overrides,
});
const adapter = (overrides: Partial<LinkedInConfig> = {}) =>
  new LinkedInSocialAdapter(
    config(overrides),
    observer,
    new MediaFiles(storage, scratch),
  );

const account: AuthorizedAccount = {
  connectionId: 'conn-1',
  churchId: 'church-1',
  platform: 'linkedin',
  providerAccountId: 'urn:li:person:abc',
  accountName: 'Pastor Jo',
  scopes: ['w_member_social'],
  metadata: { authorUrn: 'urn:li:person:abc', kind: 'person' },
  accessToken: 'member-token',
};
const publishInput = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  platform: 'linkedin',
  account,
  idempotencyKey: 'pub-1',
  text: 'Sunday sermon',
  media: [],
  settings: {},
  ...overrides,
});
const image = (key: string) => ({
  type: 'image' as const,
  url: `https://cdn.example/${key}`,
  objectKey: key,
  mimeType: 'image/png',
});
const contentOf = (call: Call | undefined) =>
  (call?.body as { content?: unknown } | undefined)?.content;
const created = (urn: string) => () => json(201, null, { 'x-restli-id': urn });

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SocialProviderError);
  return error as SocialProviderError;
};

afterEach(() => {
  vi.unstubAllGlobals();
  objects.clear();
});

// ───────────── OAuth ─────────────

describe('LinkedIn OAuth', () => {
  const authInput = {
    state: 'state-1',
    redirectUri: 'https://app.example/callback',
    platforms: ['linkedin' as const],
    codeVerifier: 'v'.repeat(43),
  };

  it('requests member scopes only, without PKCE, unless organisations are enabled', async () => {
    const personal = new URL(await adapter().getAuthorizationUrl(authInput));
    expect(personal.origin + personal.pathname).toBe(
      'https://www.linkedin.com/oauth/v2/authorization',
    );
    expect(personal.searchParams.get('scope')).toBe(
      'openid profile w_member_social',
    );
    expect(personal.searchParams.get('response_type')).toBe('code');
    expect(personal.searchParams.get('state')).toBe('state-1');
    expect(personal.searchParams.has('code_challenge')).toBe(false);

    const pages = new URL(
      await adapter({ organizations: true }).getAuthorizationUrl(authInput),
    );
    expect(pages.searchParams.get('scope')).toBe(
      'openid profile w_member_social r_organization_social w_organization_social rw_organization_admin',
    );
  });

  const callback = {
    code: 'code-1',
    redirectUri: authInput.redirectUri,
    codeVerifier: 'x',
    platforms: ['linkedin' as const],
  };
  const tokenRoute: [string, Responder] = [
    'POST oauth/v2/accessToken',
    () =>
      json(200, {
        access_token: 'member-token',
        expires_in: 5_184_000,
        scope: 'openid,profile,w_member_social',
      }),
  ];
  const userInfoRoute: [string, Responder] = [
    'GET /v2/userinfo',
    () =>
      json(200, {
        sub: 'abc',
        name: 'Pastor Jo',
        picture: 'https://media.example/jo.jpg',
      }),
  ];

  it('exchanges the code for the member account', async () => {
    const calls = stubLinkedIn([tokenRoute, userInfoRoute]);
    const { accounts } = await adapter().exchangeAuthorizationCode(callback);
    expect(accounts).toEqual([
      expect.objectContaining({
        platform: 'linkedin',
        providerAccountId: 'urn:li:person:abc',
        accountName: 'Pastor Jo',
        avatarUrl: 'https://media.example/jo.jpg',
        accessToken: 'member-token',
        scopes: ['openid', 'profile', 'w_member_social'],
        metadata: { authorUrn: 'urn:li:person:abc', kind: 'person' },
      }),
    ]);
    expect(accounts[0]?.tokenExpiresAt).toBeInstanceOf(Date);
    expect(accounts[0]?.refreshToken).toBeUndefined();
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
    expect(calls[0]?.url).not.toContain('code-1');
    expect(calls[1]?.headers.Authorization).toBe('Bearer member-token');
  });

  it('adds one account per administered Page when organisations are enabled', async () => {
    const calls = stubLinkedIn([
      tokenRoute,
      userInfoRoute,
      [
        'GET organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
        () =>
          json(200, {
            elements: [
              {
                role: 'ADMINISTRATOR',
                state: 'APPROVED',
                organizationTarget: 'urn:li:organization:111',
              },
              {
                role: 'ADMINISTRATOR',
                state: 'APPROVED',
                organization: 'urn:li:organization:222',
              },
            ],
          }),
      ],
      [
        'GET rest/organizations/111',
        () => json(200, { id: 111, localizedName: 'Grace Church' }),
      ],
      [
        'GET rest/organizations/222',
        () => json(404, { status: 404, code: 'NOT_FOUND' }),
      ],
    ]);
    const { accounts } = await adapter({
      organizations: true,
    }).exchangeAuthorizationCode(callback);
    expect(
      accounts.map((a) => [a.providerAccountId, a.accountName, a.metadata]),
    ).toEqual([
      [
        'urn:li:person:abc',
        'Pastor Jo',
        { authorUrn: 'urn:li:person:abc', kind: 'person' },
      ],
      [
        'urn:li:organization:111',
        'Grace Church',
        { authorUrn: 'urn:li:organization:111', kind: 'organization' },
      ],
      [
        'urn:li:organization:222',
        'LinkedIn Page 222',
        { authorUrn: 'urn:li:organization:222', kind: 'organization' },
      ],
    ]);
    expect(accounts.every((a) => a.accessToken === 'member-token')).toBe(true);
    const aclCall = calls.find((call) => call.url.includes('organizationAcls'));
    expect(aclCall?.headers['LinkedIn-Version']).toBe('202609');
    expect(aclCall?.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
  });

  it('still connects the member profile when the organisation lookup is forbidden', async () => {
    stubLinkedIn([
      tokenRoute,
      userInfoRoute,
      [
        'GET organizationAcls',
        () =>
          json(403, {
            status: 403,
            serviceErrorCode: 100,
            code: 'ACCESS_DENIED',
          }),
      ],
    ]);
    const { accounts } = await adapter({
      organizations: true,
    }).exchangeAuthorizationCode(callback);
    expect(accounts.map((a) => a.providerAccountId)).toEqual([
      'urn:li:person:abc',
    ]);
  });

  it('cannot refresh without a refresh token, and refreshes with one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await adapter().refreshConnection(account)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const calls = stubLinkedIn([
      [
        'POST oauth/v2/accessToken',
        () =>
          json(200, {
            access_token: 'new-token',
            expires_in: 5_184_000,
            refresh_token: 'refresh-2',
            refresh_token_expires_in: 100,
          }),
      ],
    ]);
    const refreshed = await adapter().refreshConnection({
      ...account,
      refreshToken: 'refresh-1',
    });
    expect(refreshed).toMatchObject({
      accessToken: 'new-token',
      refreshToken: 'refresh-2',
    });
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
  });

  it('maps a dead refresh token to AUTH_EXPIRED', async () => {
    stubLinkedIn([
      [
        'POST oauth/v2/accessToken',
        () =>
          json(400, {
            error: 'invalid_request',
            error_description:
              'The provided authorization grant or refresh token is invalid, expired or revoked',
          }),
      ],
    ]);
    const error = await rejection(
      adapter().refreshConnection({ ...account, refreshToken: 'old' }),
    );
    expect(error.code).toBe('AUTH_EXPIRED');
  });

  it('revokes best effort', async () => {
    const calls = stubLinkedIn([['POST oauth/v2/revoke', () => json(500, {})]]);
    await expect(adapter().revokeConnection(account)).resolves.toBeUndefined();
    expect(calls[0]?.body).toMatchObject({
      token: 'member-token',
      client_id: 'client-id',
    });
  });
});

// ───────────── Publishing ─────────────

describe('LinkedIn publishing', () => {
  it('publishes a text post with the configured API version, as the decisive call', async () => {
    const calls = stubLinkedIn([
      ['POST rest/posts', created('urn:li:share:1')],
    ]);
    const outcome = await adapter().publish(
      publishInput({ text: 'Join us (10am) #Sunday' }),
    );
    expect(outcome).toEqual({
      status: 'published',
      providerPostId: 'urn:li:share:1',
      permalink: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
    });
    const [call] = calls;
    expect(call?.url).toBe('https://api.linkedin.com/rest/posts');
    expect(call?.headers['LinkedIn-Version']).toBe('202609');
    expect(call?.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(call?.headers.Authorization).toBe('Bearer member-token');
    expect(call?.body).toEqual({
      author: 'urn:li:person:abc',
      commentary: 'Join us \\(10am\\) {hashtag|\\#|Sunday}',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('uploads one image and attaches it as content.media', async () => {
    objects.set('img-1', Buffer.from('png-bytes'));
    const calls = stubLinkedIn([
      [
        'POST rest/images?action=initializeUpload',
        () =>
          json(200, {
            value: {
              uploadUrl: 'https://www.linkedin.com/dms-uploads/img1',
              image: 'urn:li:image:1',
            },
          }),
      ],
      ['PUT dms-uploads/img1', () => new Response(null, { status: 201 })],
      ['POST rest/posts', created('urn:li:share:2')],
    ]);
    const outcome = await adapter().publish(
      publishInput({ media: [image('img-1')] }),
    );
    expect(outcome).toMatchObject({
      status: 'published',
      providerPostId: 'urn:li:share:2',
    });
    expect(calls[0]?.body).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:abc' },
    });
    expect(calls[1]?.bytes?.toString()).toBe('png-bytes');
    expect(calls[1]?.headers.Authorization).toBe('Bearer member-token');
    expect(contentOf(calls[2])).toEqual({ media: { id: 'urn:li:image:1' } });
  });

  it('uploads several images as a multiImage post', async () => {
    objects.set('a', Buffer.from('a'));
    objects.set('b', Buffer.from('b'));
    const calls = stubLinkedIn([
      [
        'POST images?action=initializeUpload',
        () =>
          json(200, {
            value: {
              uploadUrl: 'https://up.example/a',
              image: 'urn:li:image:a',
            },
          }),
      ],
      ['PUT up.example/a', () => new Response(null, { status: 201 })],
      [
        'POST images?action=initializeUpload',
        () =>
          json(200, {
            value: {
              uploadUrl: 'https://up.example/b',
              image: 'urn:li:image:b',
            },
          }),
      ],
      ['PUT up.example/b', () => new Response(null, { status: 201 })],
      ['POST rest/posts', created('urn:li:share:3')],
    ]);
    await adapter().publish(publishInput({ media: [image('a'), image('b')] }));
    expect(contentOf(calls.at(-1))).toEqual({
      multiImage: {
        images: [{ id: 'urn:li:image:a' }, { id: 'urn:li:image:b' }],
      },
    });
  });

  const video = {
    type: 'video' as const,
    url: 'https://cdn.example/v',
    objectKey: 'vid',
    mimeType: 'video/mp4',
  };

  it('uploads a video in parts, finalizes with the ETags, and waits while LinkedIn processes it', async () => {
    objects.set('vid', Buffer.from('0123456789'));
    const calls = stubLinkedIn([
      [
        'POST videos?action=initializeUpload',
        () =>
          json(200, {
            value: {
              video: 'urn:li:video:v1',
              uploadToken: 'tok',
              uploadInstructions: [
                {
                  uploadUrl: 'https://up.example/p1',
                  firstByte: 0,
                  lastByte: 5,
                },
                {
                  uploadUrl: 'https://up.example/p2',
                  firstByte: 6,
                  lastByte: 9,
                },
              ],
            },
          }),
      ],
      [
        'PUT up.example/p1',
        () =>
          new Response(null, { status: 200, headers: { etag: '"etag-1"' } }),
      ],
      [
        'PUT up.example/p2',
        () => new Response(null, { status: 200, headers: { etag: 'etag-2' } }),
      ],
      ['POST videos?action=finalizeUpload', () => json(200, null)],
      [
        'GET rest/videos/urn%3Ali%3Avideo%3Av1',
        () => json(200, { id: 'urn:li:video:v1', status: 'PROCESSING' }),
      ],
    ]);
    const outcome = await adapter().publish(
      publishInput({ media: [video], title: 'Sermon clip' }),
    );
    expect(outcome).toEqual({
      status: 'processing',
      providerRef: 'urn:li:video:v1',
      checkAfterSeconds: 20,
      metadata: { videoUrn: 'urn:li:video:v1' },
    });
    expect(calls[0]?.body).toEqual({
      initializeUploadRequest: {
        owner: 'urn:li:person:abc',
        fileSizeBytes: 10,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    });
    expect(calls[1]?.bytes?.toString()).toBe('012345');
    expect(calls[1]?.headers['Content-Length']).toBe('6');
    expect(calls[2]?.bytes?.toString()).toBe('6789');
    expect(calls[3]?.body).toEqual({
      finalizeUploadRequest: {
        video: 'urn:li:video:v1',
        uploadToken: 'tok',
        uploadedPartIds: ['etag-1', 'etag-2'],
      },
    });
    expect(calls.some((call) => call.url.endsWith('/rest/posts'))).toBe(false);
  });

  it('creates the video post once the video is AVAILABLE', async () => {
    const calls = stubLinkedIn([
      ['GET rest/videos/', () => json(200, { status: 'AVAILABLE' })],
      ['POST rest/posts', created('urn:li:ugcPost:9')],
    ]);
    const outcome = await adapter().checkPublication({
      ...publishInput({ media: [video], title: 'Sermon clip' }),
      providerRef: 'urn:li:video:v1',
      providerMetadata: { videoUrn: 'urn:li:video:v1' },
    });
    expect(outcome).toEqual({
      status: 'published',
      providerPostId: 'urn:li:ugcPost:9',
      permalink: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:9/',
    });
    expect(contentOf(calls[1])).toEqual({
      media: { id: 'urn:li:video:v1', title: 'Sermon clip' },
    });
  });

  it('fails a video LinkedIn could not process as INVALID_MEDIA, not published', async () => {
    stubLinkedIn([
      ['GET rest/videos/', () => json(200, { status: 'PROCESSING_FAILED' })],
    ]);
    const error = await rejection(
      adapter().checkPublication({
        ...publishInput({ media: [video] }),
        providerRef: 'urn:li:video:v1',
        providerMetadata: {},
      }),
    );
    expect(error).toMatchObject({
      code: 'INVALID_MEDIA',
      outcome: 'not_published',
      retryable: false,
    });
  });

  it('maps 401 to AUTH_EXPIRED', async () => {
    stubLinkedIn([
      [
        'POST rest/posts',
        () =>
          json(401, {
            status: 401,
            serviceErrorCode: 65601,
            code: 'REVOKED_ACCESS_TOKEN',
          }),
      ],
    ]);
    const error = await rejection(adapter().publish(publishInput()));
    expect(error).toMatchObject({
      code: 'AUTH_EXPIRED',
      retryable: false,
      outcome: 'not_published',
    });
  });

  it('maps 429 to a retryable RATE_LIMITED', async () => {
    stubLinkedIn([
      [
        'POST rest/posts',
        () => json(429, { status: 429, code: 'TOO_MANY_REQUESTS' }),
      ],
    ]);
    const error = await rejection(adapter().publish(publishInput()));
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      outcome: 'not_published',
    });
  });

  it('treats a 5xx on POST /rest/posts as outcome unknown, never retried', async () => {
    stubLinkedIn([
      [
        'POST rest/posts',
        () => json(502, { status: 502 }, { 'x-li-uuid': 'req-9' }),
      ],
    ]);
    const error = await rejection(adapter().publish(publishInput()));
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      outcome: 'unknown',
      retryable: false,
      providerRequestId: 'req-9',
    });
  });

  it('treats a 5xx before the decisive call as retryable and not published', async () => {
    objects.set('img-1', Buffer.from('x'));
    stubLinkedIn([
      ['POST images?action=initializeUpload', () => json(503, {})],
    ]);
    const error = await rejection(
      adapter().publish(publishInput({ media: [image('img-1')] })),
    );
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      outcome: 'not_published',
      retryable: true,
    });
  });

  it('rejects duplicates as UNSUPPORTED_CONTENT', async () => {
    stubLinkedIn([
      [
        'POST rest/posts',
        () =>
          json(422, {
            status: 422,
            message: 'Content is a duplicate of urn:li:share:1',
          }),
      ],
    ]);
    const error = await rejection(adapter().publish(publishInput()));
    expect(error.code).toBe('UNSUPPORTED_CONTENT');
  });

  it('deletes by encoded URN and reads metrics', async () => {
    const calls = stubLinkedIn([
      [
        'DELETE rest/posts/urn%3Ali%3Ashare%3A1',
        () => new Response(null, { status: 204 }),
      ],
      [
        'GET rest/socialActions/urn%3Ali%3Ashare%3A1',
        () =>
          json(200, {
            likesSummary: { totalLikes: 4 },
            commentsSummary: { aggregatedTotalComments: 2 },
          }),
      ],
    ]);
    const target = {
      platform: 'linkedin' as const,
      account,
      providerPostId: 'urn:li:share:1',
    };
    await adapter().delete(target);
    expect(await adapter().getMetrics(target)).toEqual({
      likes: 4,
      comments: 2,
    });
    expect(calls[0]?.headers['LinkedIn-Version']).toBe('202609');
  });
});

describe('escapeLittleText', () => {
  it('escapes every reserved character', () => {
    expect(escapeLittleText('a\\b|c{d}e@f[g]h(i)j<k>l*m_n~o')).toBe(
      'a\\\\b\\|c\\{d\\}e\\@f\\[g\\]h\\(i\\)j\\<k\\>l\\*m\\_n\\~o',
    );
  });

  it('keeps hashtags clickable through the hashtag template and escapes a lone #', () => {
    expect(escapeLittleText('#Faith and #hope_2 # alone, mid#word')).toBe(
      '{hashtag|\\#|Faith} and {hashtag|\\#|hope\\_2} \\# alone, mid\\#word',
    );
  });

  it('leaves plain text and newlines alone', () => {
    expect(escapeLittleText('Line one.\nLine two!')).toBe(
      'Line one.\nLine two!',
    );
  });
});

describe('LinkedIn capabilities', () => {
  it('flags personal-only posting unless organisations are enabled', async () => {
    const [personal] = await adapter().getCapabilities();
    expect(personal).toMatchObject({
      platform: 'linkedin',
      configured: true,
      maxImages: 20,
      minCarouselImages: 2,
      maxCaptionLength: 3000,
      videoContentTypes: ['video/mp4'],
    });
    expect(personal?.restrictions).toContain(
      'Posts to personal profiles only. Company Page posting needs LinkedIn Community Management API approval.',
    );
    const [pages] = await adapter({ organizations: true }).getCapabilities();
    expect(
      pages?.restrictions.some((text) =>
        text.includes('personal profiles only'),
      ),
    ).toBe(false);
    const [unconfigured] = await adapter({
      clientId: undefined,
    }).getCapabilities();
    expect(unconfigured?.configured).toBe(false);
  });
});
