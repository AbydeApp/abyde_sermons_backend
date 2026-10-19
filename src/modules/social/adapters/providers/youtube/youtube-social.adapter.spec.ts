import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PublishInput,
  PublishMedia,
} from '../../ports.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import { MediaFiles } from '../shared/media-download.js';
import { pkceChallenge } from '../shared/pkce.js';
import { YouTubeSocialAdapter } from './youtube-social.adapter.js';

const KIB = 1024;
const CHUNK = 256 * KIB;
const SESSION =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1';
const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}
type Route = (call: Call) => Response;

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
/** How Google answers "Resume Incomplete" when asked for `X-GUploader-No-308`. */
const resumeIncomplete = (lastByte: number) =>
  new Response(null, {
    status: 200,
    headers: {
      'X-HTTP-Status-Code-Override': '308',
      Range: `bytes=0-${lastByte}`,
    },
  });
const googleError = (status: number, reason: string) =>
  json(status, {
    error: {
      code: status,
      message: reason,
      errors: [{ reason, domain: 'youtube' }],
    },
  });

/** Answers each request with the next route and records what was sent (bodies drained). */
function stubFetch(...routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        ),
        body: init.body
          ? Buffer.from(await new Response(init.body).arrayBuffer())
          : Buffer.alloc(0),
      };
      calls.push(call);
      const route = routes[calls.length - 1];
      if (!route)
        throw new Error(
          `Unexpected request #${calls.length}: ${call.method} ${url}`,
        );
      return route(call);
    }),
  );
  return calls;
}

const objects = new Map<string, Buffer>();
const media = new MediaFiles(
  {
    downloadToFile: async (key: string, path: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`missing object ${key}`);
      await writeFile(path, bytes);
    },
  } as never,
  {
    withDirectory: async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
      const dir = await mkdtemp(join(tmpdir(), 'yt-'));
      try {
        return await fn(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
);
const observer = {
  providerCall: vi.fn(),
  publication: vi.fn(),
  tokenRefresh: vi.fn(),
};
const adapter = (
  config: { clientId?: string; clientSecret?: string } = {
    clientId: 'cid',
    clientSecret: 'secret',
  },
) =>
  new YouTubeSocialAdapter({ ...config, timeoutMs: 5_000 }, observer, media, {
    chunkSizeBytes: CHUNK,
  });

const account: AuthorizedAccount = {
  connectionId: 'conn-1',
  churchId: 'church-1',
  platform: 'youtube',
  providerAccountId: 'UC123',
  accountName: 'Grace Church',
  scopes: [UPLOAD_SCOPE, READONLY_SCOPE],
  metadata: { channelId: 'UC123' },
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
};

const videoBytes = (size: number) => {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return bytes;
};
const video = (
  key: string,
  size: number,
  extra: Partial<PublishMedia> = {},
): PublishMedia => {
  objects.set(key, videoBytes(size));
  return {
    type: 'video',
    url: 'https://cdn.example/v.mp4',
    objectKey: key,
    mimeType: 'video/mp4',
    sizeBytes: size,
    ...extra,
  };
};
const publishInput = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  platform: 'youtube',
  account,
  idempotencyKey: 'pub-1',
  title: 'Sunday <Sermon> on Grace',
  text: 'Pastor Jo preaches on grace.\nJoin us next week.',
  media: [video('clips/a.mp4', 10 * KIB)],
  settings: {
    privacyStatus: 'unlisted',
    madeForKids: false,
    tags: ['sermon', 'grace church'],
  },
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SocialProviderError);
  return error as SocialProviderError;
};

describe('YouTubeSocialAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('OAuth', () => {
    it('asks for offline access with a consent prompt, PKCE S256 and both scopes', async () => {
      const url = new URL(
        await adapter().getAuthorizationUrl({
          state: 'state-1',
          redirectUri: 'https://api.example/callback/youtube',
          platforms: ['youtube'],
          codeVerifier: 'v'.repeat(64),
        }),
      );
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      const params = url.searchParams;
      expect(params.get('client_id')).toBe('cid');
      expect(params.get('redirect_uri')).toBe(
        'https://api.example/callback/youtube',
      );
      expect(params.get('response_type')).toBe('code');
      expect(params.get('access_type')).toBe('offline');
      expect(params.get('prompt')).toBe('consent');
      expect(params.get('include_granted_scopes')).toBe('true');
      expect(params.get('state')).toBe('state-1');
      expect(params.get('code_challenge')).toBe(pkceChallenge('v'.repeat(64)));
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('scope')?.split(' ').sort()).toEqual(
        [UPLOAD_SCOPE, READONLY_SCOPE].sort(),
      );
    });

    it('exchanges the code and returns the channel with its refresh token and expiry', async () => {
      const calls = stubFetch(
        () =>
          json(200, {
            access_token: 'at-1',
            expires_in: 3599,
            refresh_token: 'rt-1',
            scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
            token_type: 'Bearer',
          }),
        () =>
          json(200, {
            items: [
              {
                id: 'UC123',
                snippet: {
                  title: 'Grace Church',
                  customUrl: '@gracechurch',
                  thumbnails: {
                    default: { url: 'https://yt3.ggpht.com/a.jpg' },
                  },
                },
              },
            ],
          }),
      );
      const before = Date.now();
      const { accounts } = await adapter().exchangeAuthorizationCode({
        code: 'code-1',
        redirectUri: 'https://api.example/callback/youtube',
        codeVerifier: 'verifier-1',
        platforms: ['youtube'],
      });

      const token = new URLSearchParams(calls[0]?.body.toString());
      expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
      expect(Object.fromEntries(token)).toEqual({
        code: 'code-1',
        client_id: 'cid',
        client_secret: 'secret',
        redirect_uri: 'https://api.example/callback/youtube',
        grant_type: 'authorization_code',
        code_verifier: 'verifier-1',
      });
      expect(calls[1]?.url).toBe(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      );
      expect(calls[1]?.headers.authorization).toBe('Bearer at-1');

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        platform: 'youtube',
        providerAccountId: 'UC123',
        accountName: 'Grace Church',
        avatarUrl: 'https://yt3.ggpht.com/a.jpg',
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        scopes: [UPLOAD_SCOPE, READONLY_SCOPE],
        metadata: { channelId: 'UC123', customUrl: '@gracechurch' },
      });
      const expiresAt = accounts[0]?.tokenExpiresAt?.getTime() ?? 0;
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3599_000);
    });

    it('rejects a Google account without a YouTube channel', async () => {
      stubFetch(
        () =>
          json(200, {
            access_token: 'at-1',
            expires_in: 3599,
            scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
          }),
        () => json(200, { items: [] }),
      );
      const error = await failure(
        adapter().exchangeAuthorizationCode({
          code: 'c',
          redirectUri: 'https://api.example/cb',
          codeVerifier: 'v',
          platforms: ['youtube'],
        }),
      );
      expect(error.code).toBe('PERMISSION_DENIED');
    });

    it('rejects a consent where the upload scope was unticked, before listing channels', async () => {
      const calls = stubFetch(() =>
        json(200, { access_token: 'at-1', scope: READONLY_SCOPE }),
      );
      const error = await failure(
        adapter().exchangeAuthorizationCode({
          code: 'c',
          redirectUri: 'https://api.example/cb',
          codeVerifier: 'v',
          platforms: ['youtube'],
        }),
      );
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(calls).toHaveLength(1);
    });

    it('refreshes without inventing a rotated refresh token', async () => {
      const calls = stubFetch(() =>
        json(200, {
          access_token: 'at-2',
          expires_in: 3599,
          scope: UPLOAD_SCOPE,
        }),
      );
      const result = await adapter().refreshConnection(account);
      expect(
        Object.fromEntries(new URLSearchParams(calls[0]?.body.toString())),
      ).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
      });
      expect(calls[0]?.url).not.toContain('refresh-token');
      expect(result).toMatchObject({
        accessToken: 'at-2',
        refreshToken: undefined,
        scopes: [UPLOAD_SCOPE],
      });
      expect(result?.tokenExpiresAt).toBeInstanceOf(Date);
    });

    it('maps invalid_grant on refresh to AUTH_EXPIRED, and needs a refresh token to try', async () => {
      stubFetch(() =>
        json(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
      );
      const error = await failure(adapter().refreshConnection(account));
      expect(error.code).toBe('AUTH_EXPIRED');
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain('refresh-token');
      expect(
        await adapter().refreshConnection({
          ...account,
          refreshToken: undefined,
        }),
      ).toBeNull();
    });

    it('revokes the refresh token and treats an already invalid token as revoked', async () => {
      const calls = stubFetch(() =>
        json(400, {
          error: 'invalid_token',
          error_description: 'Token expired or revoked',
        }),
      );
      await expect(
        adapter().revokeConnection(account),
      ).resolves.toBeUndefined();
      expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
      expect(calls[0]?.body.toString()).toBe('token=refresh-token');
    });
  });

  describe('publish', () => {
    it('opens a resumable session, uploads chunks following Range, and returns the watch URL', async () => {
      const size = 2 * CHUNK + 88 * KIB; // 614400 bytes
      const input = publishInput({ media: [video('clips/long.mp4', size)] });
      const calls = stubFetch(
        () => json(200, {}, { Location: SESSION }),
        () => resumeIncomplete(CHUNK - 1),
        // YouTube kept only half of the second chunk: the next one must start right after it.
        () => resumeIncomplete(CHUNK + CHUNK / 2 - 1),
        () =>
          json(200, {
            id: 'vid-1',
            status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' },
          }),
      );

      const outcome = await adapter().publish(input);

      const [start, ...chunks] = calls;
      expect(start?.method).toBe('POST');
      expect(start?.url).toBe(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      );
      expect(start?.headers.authorization).toBe('Bearer access-token');
      expect(start?.headers['x-upload-content-length']).toBe(String(size));
      expect(start?.headers['x-upload-content-type']).toBe('video/mp4');
      expect(JSON.parse(start?.body.toString() ?? '')).toEqual({
        snippet: {
          title: 'Sunday Sermon on Grace',
          description: 'Pastor Jo preaches on grace.\nJoin us next week.',
          tags: ['sermon', 'grace church'],
          categoryId: '22',
        },
        status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
      });

      const bytes = objects.get('clips/long.mp4') ?? Buffer.alloc(0);
      const ranges = [
        [0, CHUNK - 1],
        [CHUNK, 2 * CHUNK - 1],
        [CHUNK + CHUNK / 2, size - 1],
      ];
      expect(chunks).toHaveLength(3);
      chunks.forEach((chunk, index) => {
        const [from = 0, to = 0] = ranges[index] ?? [];
        expect(chunk.method).toBe('PUT');
        expect(chunk.url).toBe(SESSION);
        expect(chunk.headers['content-range']).toBe(
          `bytes ${from}-${to}/${size}`,
        );
        expect(chunk.headers['content-length']).toBe(String(to - from + 1));
        expect(chunk.headers['x-guploader-no-308']).toBe('yes');
        expect(chunk.body.equals(bytes.subarray(from, to + 1))).toBe(true);
      });

      expect(outcome).toEqual({
        status: 'published',
        providerPostId: 'vid-1',
        permalink: 'https://www.youtube.com/watch?v=vid-1',
        metadata: { privacyStatus: 'unlisted' },
      });
    });

    it('keeps the publication when the custom thumbnail is refused, and links a Short', async () => {
      objects.set('thumbs/a.jpg', Buffer.from('jpeg-bytes'));
      const input = publishInput({
        media: [
          video('clips/short.mp4', 10 * KIB, {
            durationSeconds: 45,
            width: 1080,
            height: 1920,
          }),
        ],
        thumbnail: {
          type: 'image',
          url: 'https://cdn.example/t.jpg',
          objectKey: 'thumbs/a.jpg',
          mimeType: 'image/jpeg',
        },
      });
      const calls = stubFetch(
        () => json(200, {}, { Location: SESSION }),
        () =>
          json(201, {
            id: 'vid-2',
            status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' },
          }),
        () => googleError(403, 'forbidden'),
      );

      const outcome = await adapter().publish(input);

      expect(calls[2]?.url).toBe(
        'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=vid-2&uploadType=media',
      );
      expect(calls[2]?.headers['content-type']).toBe('image/jpeg');
      expect(calls[2]?.body.toString()).toBe('jpeg-bytes');
      expect(outcome).toEqual({
        status: 'published',
        providerPostId: 'vid-2',
        permalink: 'https://www.youtube.com/shorts/vid-2',
        metadata: {
          privacyStatus: 'unlisted',
          thumbnail: 'failed',
          thumbnailError: 'PERMISSION_DENIED',
        },
      });
    });

    it('maps 403 quotaExceeded to a retryable RATE_LIMITED with nothing published', async () => {
      stubFetch(() => googleError(403, 'quotaExceeded'));
      const error = await failure(adapter().publish(publishInput()));
      expect(error).toMatchObject({
        code: 'RATE_LIMITED',
        retryable: true,
        outcome: 'not_published',
        httpStatus: 403,
      });
    });

    it('treats a 5xx on the final chunk as an unknown outcome that is never retried', async () => {
      stubFetch(
        () => json(200, {}, { Location: SESSION }),
        () => googleError(503, 'backendError'),
      );
      const error = await failure(adapter().publish(publishInput()));
      expect(error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'unknown',
        retryable: false,
      });
    });

    it('treats a 5xx on an earlier chunk as retryable: the video cannot exist yet', async () => {
      stubFetch(
        () => json(200, {}, { Location: SESSION }),
        () => googleError(503, 'backendError'),
      );
      const error = await failure(
        adapter().publish(
          publishInput({ media: [video('clips/two.mp4', CHUNK + 1)] }),
        ),
      );
      expect(error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'not_published',
        retryable: true,
      });
    });

    it('treats a 5xx when opening the session as retryable, nothing published', async () => {
      stubFetch(() => googleError(500, 'backendError'));
      const error = await failure(adapter().publish(publishInput()));
      expect(error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'not_published',
        retryable: true,
      });
    });

    it('fails retryably when YouTube keeps none of a chunk (raw 308 without Range)', async () => {
      stubFetch(
        () => json(200, {}, { Location: SESSION }),
        () => new Response(null, { status: 308 }),
      );
      const error = await failure(
        adapter().publish(
          publishInput({ media: [video('clips/stall.mp4', CHUNK + 1)] }),
        ),
      );
      expect(error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'not_published',
        retryable: true,
      });
    });

    it('refuses a session URI outside Google, so the token never leaves', async () => {
      const calls = stubFetch(() =>
        json(200, {}, { Location: 'https://evil.example/upload' }),
      );
      const error = await failure(adapter().publish(publishInput()));
      expect(error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        outcome: 'not_published',
      });
      expect(calls).toHaveLength(1);
    });

    it('rejects posts without exactly one video before calling YouTube', async () => {
      const calls = stubFetch();
      const image: PublishMedia = {
        type: 'image',
        url: 'u',
        objectKey: 'k',
        mimeType: 'image/jpeg',
      };
      for (const mediaItems of [
        [],
        [image],
        [video('clips/a.mp4', KIB), image],
      ]) {
        const error = await failure(
          adapter().publish(publishInput({ media: mediaItems })),
        );
        expect(error.code).toBe('UNSUPPORTED_CONTENT');
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('metrics and delete', () => {
    it('reads view, like and comment counts', async () => {
      const calls = stubFetch(() =>
        json(200, {
          items: [
            {
              id: 'vid-1',
              statistics: {
                viewCount: '120',
                likeCount: '7',
                commentCount: '2',
              },
            },
          ],
        }),
      );
      expect(
        await adapter().getMetrics({
          platform: 'youtube',
          account,
          providerPostId: 'vid-1',
        }),
      ).toEqual({
        views: 120,
        likes: 7,
        comments: 2,
      });
      expect(calls[0]?.url).toBe(
        'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=vid-1',
      );
    });

    it('does not attempt a delete without a channel management scope', async () => {
      const calls = stubFetch();
      const error = await failure(
        adapter().delete({
          platform: 'youtube',
          account,
          providerPostId: 'vid-1',
        }),
      );
      expect(error.code).toBe('UNSUPPORTED_CONTENT');
      expect(calls).toHaveLength(0);
    });

    it('deletes with a management scope and treats 404 as already deleted', async () => {
      const manager = {
        ...account,
        scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      };
      const calls = stubFetch(() => googleError(404, 'videoNotFound'));
      await expect(
        adapter().delete({
          platform: 'youtube',
          account: manager,
          providerPostId: 'vid-1',
        }),
      ).resolves.toBeUndefined();
      expect(calls[0]).toMatchObject({
        method: 'DELETE',
        url: 'https://www.googleapis.com/youtube/v3/videos?id=vid-1',
      });
    });
  });

  it('describes YouTube capabilities and whether credentials are configured', async () => {
    const [capabilities] = await adapter().getCapabilities();
    expect(capabilities).toMatchObject({
      platform: 'youtube',
      configured: true,
      textOnly: false,
      images: false,
      carousel: false,
      video: true,
      shortVideo: true,
      maxImages: 0,
      maxCaptionLength: 5000,
      titleRequired: true,
      maxTitleLength: 100,
      imageContentTypes: [],
      videoContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
      minVideoDurationSeconds: 1,
      maxVideoDurationSeconds: 43_200,
    });
    expect(capabilities?.restrictions.join(' ')).toMatch(/private/);
    expect(capabilities?.restrictions.join(' ')).toMatch(/quota/);
    const [unconfigured] = await adapter({}).getCapabilities();
    expect(unconfigured?.configured).toBe(false);
    expect(adapter({ clientId: 'cid' }).isConfigured()).toBe(false);
  });
});
