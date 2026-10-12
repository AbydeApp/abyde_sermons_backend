import type { PublishInput } from '../../../application/ports/out/social-publishing.port.js';
import type { AuthorizedAccount } from '../../../domain/social-connection.js';
import { SocialProviderError } from '../../../domain/social-errors.js';
import { TikTokSocialAdapter } from './tiktok-social.adapter.js';
import type { TikTokConfig } from './tiktok.types.js';

const observer = {
  providerCall: () => undefined,
  publication: () => undefined,
  tokenRefresh: () => undefined,
};
const config: TikTokConfig = {
  clientKey: 'client-key',
  clientSecret: 'client-secret',
  timeoutMs: 5_000,
  audited: false,
};
const adapter = (overrides: Partial<TikTokConfig> = {}) =>
  new TikTokSocialAdapter({ ...config, ...overrides }, observer);

const account: AuthorizedAccount = {
  connectionId: 'c1',
  churchId: 'church-1',
  platform: 'tiktok',
  providerAccountId: 'open-1',
  accountName: 'Grace Church',
  scopes: ['user.info.basic', 'video.publish'],
  metadata: { openId: 'open-1' },
  accessToken: 'act.secret',
  refreshToken: 'rft.secret',
};
const videoInput: PublishInput = {
  platform: 'tiktok',
  account,
  idempotencyKey: 'pub-1',
  text: 'Sunday message #faith',
  media: [
    {
      type: 'video',
      url: 'https://media.example.org/clip.mp4',
      objectKey: 'clip.mp4',
      mimeType: 'video/mp4',
    },
  ],
  settings: {
    privacyLevel: 'PUBLIC_TO_EVERYONE',
    disableComment: false,
    disableDuet: true,
    disableStitch: false,
  },
};

const ok = { code: 'ok', message: '', log_id: 'log-ok' };
const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
type Call = { url: string; init: RequestInit; body: string };
/** Stubs fetch with a handler and records every call. */
const stubFetch = (handler: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    const raw = init.body;
    const body =
      typeof raw === 'string'
        ? raw
        : raw instanceof URLSearchParams
          ? raw.toString()
          : '';
    const call = { url: String(url), init, body };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', mock);
  return calls;
};
const bodyOf = (call: Call | undefined) =>
  JSON.parse(call?.body ?? 'null') as Record<string, any>;
const formOf = (call: Call | undefined) => new URLSearchParams(call?.body);
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as SocialProviderError;
  }
  throw new Error('expected a rejection');
};

describe('TikTokSocialAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('OAuth', () => {
    it('builds the Login Kit authorization URL with client_key, scope, state and redirect_uri', async () => {
      const url = new URL(
        await adapter().getAuthorizationUrl({
          state: 'state-123',
          redirectUri: 'https://api.example.org/social/callback/tiktok',
          platforms: ['tiktok'],
          codeVerifier: 'v'.repeat(43),
        }),
      );
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://www.tiktok.com/v2/auth/authorize/',
      );
      expect(url.searchParams.get('client_key')).toBe('client-key');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe(
        'user.info.basic,video.publish',
      );
      expect(url.searchParams.get('state')).toBe('state-123');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.org/social/callback/tiktok',
      );
      expect(url.searchParams.has('code_challenge')).toBe(false);
    });

    it('exchanges the code for exactly one connected account', async () => {
      const calls = stubFetch(({ url }) =>
        url.includes('/v2/oauth/token/')
          ? json(200, {
              access_token: 'act.new',
              expires_in: 86_400,
              open_id: 'open-1',
              refresh_token: 'rft.new',
              refresh_expires_in: 31_536_000,
              scope: 'user.info.basic,video.publish',
              token_type: 'Bearer',
            })
          : json(200, {
              data: {
                user: {
                  open_id: 'open-1',
                  union_id: 'union-1',
                  avatar_url: 'https://p16.tiktokcdn.com/a.jpg',
                  display_name: 'Grace Church',
                },
              },
              error: ok,
            }),
      );
      const before = Date.now();
      const { accounts } = await adapter().exchangeAuthorizationCode({
        code: 'auth-code',
        redirectUri: 'https://api.example.org/social/callback/tiktok',
        codeVerifier: 'v'.repeat(43),
        platforms: ['tiktok'],
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        platform: 'tiktok',
        providerAccountId: 'open-1',
        accountName: 'Grace Church',
        avatarUrl: 'https://p16.tiktokcdn.com/a.jpg',
        accessToken: 'act.new',
        refreshToken: 'rft.new',
        scopes: ['user.info.basic', 'video.publish'],
        metadata: { openId: 'open-1', unionId: 'union-1' },
      });
      const expiry = accounts[0]?.tokenExpiresAt?.getTime() ?? 0;
      expect(expiry).toBeGreaterThanOrEqual(before + 86_400_000);
      expect(expiry).toBeLessThan(before + 86_400_000 + 60_000);

      const token = formOf(calls[0]);
      expect(calls[0]?.init.method).toBe('POST');
      expect(token.get('grant_type')).toBe('authorization_code');
      expect(token.get('code')).toBe('auth-code');
      expect(token.get('client_key')).toBe('client-key');
      expect(token.get('client_secret')).toBe('client-secret');
      // Tokens travel in headers, never in URLs.
      expect(calls[1]?.url).not.toContain('act.new');
      expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe(
        'Bearer act.new',
      );
    });

    it('treats an OAuth error payload returned with HTTP 200 as AUTH_EXPIRED', async () => {
      stubFetch(() =>
        json(200, {
          error: 'invalid_grant',
          error_description: 'Authorization code is expired.',
          log_id: 'log-1',
        }),
      );
      const error = await rejection(
        adapter().exchangeAuthorizationCode({
          code: 'secret-code',
          redirectUri: 'https://api.example.org/cb',
          codeVerifier: 'v'.repeat(43),
          platforms: ['tiktok'],
        }),
      );
      expect(error).toBeInstanceOf(SocialProviderError);
      expect(error.code).toBe('AUTH_EXPIRED');
      expect(error.providerRequestId).toBe('log-1');
      expect(error.message).not.toContain('secret-code');
    });

    it('rejects a consent that did not grant video.publish', async () => {
      stubFetch(() =>
        json(200, {
          access_token: 'act.new',
          expires_in: 86_400,
          open_id: 'open-1',
          refresh_token: 'rft.new',
          scope: 'user.info.basic',
        }),
      );
      const error = await rejection(
        adapter().exchangeAuthorizationCode({
          code: 'c',
          redirectUri: 'https://api.example.org/cb',
          codeVerifier: 'v'.repeat(43),
          platforms: ['tiktok'],
        }),
      );
      expect(error.code).toBe('PERMISSION_DENIED');
    });

    it('returns the rotated refresh token on refresh', async () => {
      const calls = stubFetch(() =>
        json(200, {
          access_token: 'act.rotated',
          expires_in: 86_400,
          open_id: 'open-1',
          refresh_token: 'rft.rotated',
          refresh_expires_in: 31_536_000,
          scope: 'user.info.basic,video.publish',
        }),
      );
      const result = await adapter().refreshConnection(account);
      expect(result).toMatchObject({
        accessToken: 'act.rotated',
        refreshToken: 'rft.rotated',
        scopes: ['user.info.basic', 'video.publish'],
      });
      expect(result?.tokenExpiresAt).toBeInstanceOf(Date);
      const sent = formOf(calls[0]);
      expect(sent.get('grant_type')).toBe('refresh_token');
      expect(sent.get('refresh_token')).toBe('rft.secret');
      expect(calls[0]?.url).not.toContain('rft.secret');
    });

    it('maps invalid_grant on refresh to AUTH_EXPIRED and returns null without a refresh token', async () => {
      stubFetch(() =>
        json(200, { error: 'invalid_grant', error_description: 'expired' }),
      );
      expect((await rejection(adapter().refreshConnection(account))).code).toBe(
        'AUTH_EXPIRED',
      );
      expect(
        await adapter().refreshConnection({
          ...account,
          refreshToken: undefined,
        }),
      ).toBeNull();
    });

    it('treats revoking an already invalid token as success', async () => {
      stubFetch(() =>
        json(200, { error: 'invalid_grant', error_description: 'bad token' }),
      );
      await expect(
        adapter().revokeConnection(account),
      ).resolves.toBeUndefined();
    });
  });

  describe('publish', () => {
    it('sends PULL_FROM_URL with privacy forced to SELF_ONLY when the app is not audited', async () => {
      const calls = stubFetch(() =>
        json(200, { data: { publish_id: 'v_pub_url~v2.123' }, error: ok }),
      );
      const outcome = await adapter().publish(videoInput);

      expect(outcome).toEqual({
        status: 'processing',
        providerRef: 'v_pub_url~v2.123',
        checkAfterSeconds: 15,
        metadata: { publishId: 'v_pub_url~v2.123', mediaType: 'video' },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        'https://open.tiktokapis.com/v2/post/publish/video/init/',
      );
      expect(bodyOf(calls[0])).toEqual({
        post_info: {
          title: 'Sunday message #faith',
          privacy_level: 'SELF_ONLY',
          disable_duet: true,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: 'https://media.example.org/clip.mp4',
        },
      });
    });

    it('keeps the chosen privacy level once the app is audited', async () => {
      const calls = stubFetch(() =>
        json(200, { data: { publish_id: 'p1' }, error: ok }),
      );
      await adapter({ audited: true }).publish(videoInput);
      expect(bodyOf(calls[0]).post_info.privacy_level).toBe(
        'PUBLIC_TO_EVERYONE',
      );
    });

    it('publishes photos through content/init in DIRECT_POST photo mode', async () => {
      const calls = stubFetch(() =>
        json(200, { data: { publish_id: 'p_pub_url~1' }, error: ok }),
      );
      const outcome = await adapter().publish({
        ...videoInput,
        title: 'Sermon notes',
        media: ['a', 'b'].map((name) => ({
          type: 'image' as const,
          url: `https://media.example.org/${name}.jpg`,
          objectKey: `${name}.jpg`,
          mimeType: 'image/jpeg',
        })),
      });
      expect(outcome).toMatchObject({
        status: 'processing',
        providerRef: 'p_pub_url~1',
      });
      expect(calls[0]?.url).toBe(
        'https://open.tiktokapis.com/v2/post/publish/content/init/',
      );
      expect(bodyOf(calls[0])).toMatchObject({
        post_info: {
          title: 'Sermon notes',
          description: 'Sunday message #faith',
          privacy_level: 'SELF_ONLY',
          auto_add_music: true,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: [
            'https://media.example.org/a.jpg',
            'https://media.example.org/b.jpg',
          ],
        },
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
      });
    });

    it('rejects a post without media before calling TikTok', async () => {
      const calls = stubFetch(() => json(200, {}));
      const error = await rejection(
        adapter().publish({ ...videoInput, media: [] }),
      );
      expect(error.code).toBe('UNSUPPORTED_CONTENT');
      expect(error.outcome).toBe('not_published');
      expect(calls).toHaveLength(0);
    });
  });

  describe('checkPublication', () => {
    const check = (status: object) => {
      stubFetch(() => json(200, { data: status, error: ok }));
      return adapter().checkPublication({
        ...videoInput,
        providerRef: 'v_pub_url~v2.123',
        providerMetadata: { publishId: 'v_pub_url~v2.123', mediaType: 'video' },
      });
    };

    it('reports PUBLISH_COMPLETE as published', async () => {
      expect(
        await check({
          status: 'PUBLISH_COMPLETE',
          publicaly_available_post_id: ['7300000000000000001'],
        }),
      ).toMatchObject({
        status: 'published',
        providerPostId: '7300000000000000001',
      });
      expect(await check({ status: 'PUBLISH_COMPLETE' })).toMatchObject({
        status: 'published',
        providerPostId: 'v_pub_url~v2.123',
      });
    });

    it('keeps every digit of a 64-bit post id sent as a JSON number', async () => {
      stubFetch(
        async () =>
          new Response(
            '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok","message":""}}',
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      expect(
        await adapter().checkPublication({
          ...videoInput,
          providerRef: 'v_pub_url~v2.123',
          providerMetadata: {
            publishId: 'v_pub_url~v2.123',
            mediaType: 'video',
          },
        }),
      ).toMatchObject({ providerPostId: '7300000000000000001' });
    });

    it('keeps processing while TikTok downloads or uploads', async () => {
      expect(await check({ status: 'PROCESSING_DOWNLOAD' })).toMatchObject({
        status: 'processing',
        providerRef: 'v_pub_url~v2.123',
        checkAfterSeconds: 15,
      });
    });

    it('maps a FAILED media check to INVALID_MEDIA, not published', async () => {
      const error = await rejection(
        check({ status: 'FAILED', fail_reason: 'file_format_check_failed' }),
      );
      expect(error.code).toBe('INVALID_MEDIA');
      expect(error.outcome).toBe('not_published');
      expect(error.retryable).toBe(false);
    });
  });

  describe('error mapping', () => {
    it('maps 401 access_token_invalid to AUTH_EXPIRED with the log id', async () => {
      stubFetch(() =>
        json(401, {
          error: {
            code: 'access_token_invalid',
            message: 'expired',
            log_id: 'log-401',
          },
        }),
      );
      const error = await rejection(adapter().publish(videoInput));
      expect(error.code).toBe('AUTH_EXPIRED');
      expect(error.providerRequestId).toBe('log-401');
      expect(error.outcome).toBe('not_published');
      expect(error.message).not.toContain('act.secret');
    });

    it('maps 429 to a retryable RATE_LIMITED', async () => {
      stubFetch(() =>
        json(429, {
          error: {
            code: 'rate_limit_exceeded',
            message: 'slow down',
            log_id: 'l',
          },
        }),
      );
      const error = await rejection(adapter().publish(videoInput));
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryable).toBe(true);
    });

    it('maps url_ownership_unverified to PERMISSION_DENIED with an ops diagnostic', async () => {
      stubFetch(() =>
        json(403, {
          error: {
            code: 'url_ownership_unverified',
            message: 'unverified',
            log_id: 'l',
          },
        }),
      );
      const error = await rejection(adapter().publish(videoInput));
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toContain('developer portal');
    });

    it('treats a 5xx on the decisive init as outcome unknown, never retried', async () => {
      stubFetch(() =>
        json(
          500,
          { error: { code: 'internal_error', message: 'oops', log_id: 'l' } },
          {
            'x-tt-logid': 'hdr-log',
          },
        ),
      );
      const error = await rejection(adapter().publish(videoInput));
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.outcome).toBe('unknown');
      expect(error.retryable).toBe(false);
    });

    it('treats a network failure on the decisive init as outcome unknown', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Promise.reject(new Error('socket hang up'))),
      );
      const error = await rejection(adapter().publish(videoInput));
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.outcome).toBe('unknown');
      expect(error.retryable).toBe(false);
    });

    it('treats a 5xx on a non-decisive status check as retryable and not published', async () => {
      stubFetch(() => json(503, {}, { 'x-tt-logid': 'hdr-log' }));
      const error = await rejection(
        adapter().checkPublication({
          ...videoInput,
          providerRef: 'p',
          providerMetadata: {},
        }),
      );
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.outcome).toBe('not_published');
      expect(error.retryable).toBe(true);
      expect(error.providerRequestId).toBe('hdr-log');
    });

    it('turns an error inside a 2xx envelope into an error', async () => {
      stubFetch(() =>
        json(200, {
          data: {},
          error: { code: 'scope_not_authorized', message: 'no', log_id: 'l' },
        }),
      );
      expect((await rejection(adapter().publish(videoInput))).code).toBe(
        'PERMISSION_DENIED',
      );
    });
  });

  describe('capabilities', () => {
    it('reflects configuration and the audit restriction', async () => {
      const [unconfigured] = await adapter({
        clientKey: undefined,
      }).getCapabilities();
      expect(unconfigured).toMatchObject({
        platform: 'tiktok',
        configured: false,
      });

      const [unaudited] = await adapter().getCapabilities();
      expect(unaudited).toMatchObject({
        configured: true,
        textOnly: false,
        video: true,
        carousel: true,
        maxImages: 35,
        maxCaptionLength: 2_200,
        maxTitleLength: 90,
      });
      expect(unaudited?.restrictions).toContain(
        'Posts are private (only you) until TikTok approves this app.',
      );
      expect(
        unaudited?.restrictions.some((entry) =>
          entry.includes('developer portal'),
        ),
      ).toBe(true);

      const [audited] = await adapter({ audited: true }).getCapabilities();
      expect(audited?.restrictions).not.toContain(
        'Posts are private (only you) until TikTok approves this app.',
      );
      expect(adapter({ clientSecret: undefined }).isConfigured()).toBe(false);
    });

    it('limits account privacy options to SELF_ONLY until audited', async () => {
      const creator = {
        data: {
          privacy_level_options: [
            'PUBLIC_TO_EVERYONE',
            'SELF_ONLY',
            'FOLLOWER_OF_CREATOR',
          ],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 300,
        },
        error: ok,
      };
      stubFetch(() => json(200, creator));
      expect(await adapter().getAccountCapabilities(account)).toMatchObject({
        platform: 'tiktok',
        privacyLevels: ['SELF_ONLY'],
        maxVideoDurationSeconds: 300,
        duetDisabled: true,
        canPost: true,
        restrictions: [
          'Posts are private (only you) until TikTok approves this app.',
        ],
      });
      expect(
        await adapter({ audited: true }).getAccountCapabilities(account),
      ).toMatchObject({
        privacyLevels: [
          'PUBLIC_TO_EVERYONE',
          'SELF_ONLY',
          'FOLLOWER_OF_CREATOR',
        ],
        restrictions: [],
      });
    });

    it('reports canPost false when TikTok blocks new posts for the creator', async () => {
      stubFetch(() =>
        json(403, {
          error: {
            code: 'spam_risk_too_many_posts',
            message: 'cap',
            log_id: 'l',
          },
        }),
      );
      expect(await adapter().getAccountCapabilities(account)).toMatchObject({
        canPost: false,
      });
    });
  });
});
