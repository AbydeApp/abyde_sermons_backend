import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  CheckPublicationInput,
  ConnectedAccounts,
  DeletePostInput,
  MetricsInput,
  PostMetrics,
  PublishInput,
  PublishMedia,
  PublishOutcome,
  RefreshResult,
  SocialPublishingPort,
} from '../../ports.js';
import type { SocialObserverPort } from '../../ports.js';
import type { PlatformCapabilities } from '../../../helper.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import type { LocalMedia, MediaFiles } from '../shared/media-download.js';
import { XApiClient, X_ENDPOINTS } from './x-api.client.js';
import { XOAuthService } from './x-oauth.service.js';
import type {
  XConfig,
  XMediaResponse,
  XProcessingInfo,
  XTweetCreateResponse,
  XTweetMetricsResponse,
} from './x.types.js';

const MB = 1024 ** 2;
const MAX_IMAGE_BYTES = 5 * MB;
const MAX_VIDEO_BYTES = 512 * MB;
/** X accepts append segments up to 5 MB; one chunk at a time is all that sits in memory. */
const CHUNK_BYTES = 4 * MB;
const VIDEO_CHECK_SECONDS = 10;
/**
 * Byte uploads (an image, one 4 MiB segment) get a longer per-attempt timeout than API calls.
 * Still one attempt each; the job's own signal bounds the whole publish.
 */
const MIN_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * X (Twitter) through the v2 API. Media is uploaded first (images one-shot, video chunked via
 * initialize/append/finalize); uploaded media is invisible until attached, so only
 * `POST /2/tweets` is decisive. Video processing is finished by status checks, never by holding
 * a request open.
 */
export class XSocialAdapter implements SocialPublishingPort {
  readonly provider = 'x' as const;
  readonly platforms = ['x'] as const;
  private readonly api: XApiClient;
  private readonly oauth: XOAuthService;

  constructor(
    private readonly config: XConfig,
    observer: SocialObserverPort,
    private readonly media: MediaFiles,
  ) {
    this.api = new XApiClient(config, observer);
    this.oauth = new XOAuthService(config, this.api);
  }

  isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async getAuthorizationUrl(input: AuthorizationInput): Promise<string> {
    return this.oauth.authorizationUrl(input);
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccounts> {
    return { accounts: await this.oauth.exchange(input) };
  }

  refreshConnection(account: AuthorizedAccount): Promise<RefreshResult | null> {
    return this.oauth.refresh(account);
  }

  revokeConnection(account: AuthorizedAccount): Promise<void> {
    return this.oauth.revoke(account);
  }

  async getCapabilities(): Promise<PlatformCapabilities[]> {
    return [xCapabilities(this.isConfigured())];
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const video = input.media.find((item) => item.type === 'video');
    if (video) {
      const uploaded = await this.uploadVideo(input, video);
      const pending = pendingCheck(uploaded.data.processing_info);
      if (pending !== null)
        return {
          status: 'processing',
          providerRef: uploaded.data.id,
          checkAfterSeconds: pending,
          metadata: { mediaIds: [uploaded.data.id] },
        };
      return this.createPost(input, [uploaded.data.id]);
    }
    const mediaIds: string[] = [];
    for (const image of input.media.filter((item) => item.type === 'image'))
      mediaIds.push(await this.uploadImage(input, image));
    return this.createPost(input, mediaIds);
  }

  /** Creates the post once X has finished processing the video; otherwise check again later. */
  async checkPublication(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    const status = await this.api.get<XMediaResponse>(
      'x.media_status',
      X_ENDPOINTS.mediaUpload,
      input.account.accessToken,
      { command: 'STATUS', media_id: input.providerRef },
      input.signal,
    );
    const pending = pendingCheck(status.data.processing_info);
    const mediaIds = mediaIdsOf(input.providerMetadata, input.providerRef);
    if (pending !== null)
      return {
        status: 'processing',
        providerRef: input.providerRef,
        checkAfterSeconds: pending,
        metadata: { mediaIds },
      };
    return this.createPost(input, mediaIds);
  }

  /** Deleting a post that is already gone succeeds, so a retried delete is harmless. */
  async delete(input: DeletePostInput): Promise<void> {
    try {
      await this.api.delete(
        'x.tweet_delete',
        X_ENDPOINTS.tweet(input.providerPostId),
        input.account.accessToken,
        input.signal,
      );
    } catch (error) {
      if (error instanceof SocialProviderError && error.httpStatus === 404)
        return;
      throw error;
    }
  }

  async getMetrics(input: MetricsInput): Promise<PostMetrics> {
    const tweet = await this.api.get<XTweetMetricsResponse>(
      'x.tweet_metrics',
      X_ENDPOINTS.tweet(input.providerPostId),
      input.account.accessToken,
      { 'tweet.fields': 'public_metrics' },
      input.signal,
    );
    const metrics = tweet.data?.public_metrics;
    if (!metrics) return {};
    return {
      impressions: metrics.impression_count,
      likes: metrics.like_count,
      comments: metrics.reply_count,
      shares:
        metrics.retweet_count === undefined && metrics.quote_count === undefined
          ? undefined
          : (metrics.retweet_count ?? 0) + (metrics.quote_count ?? 0),
      saves: metrics.bookmark_count,
    };
  }

  // ───────────────────────── Posting ─────────────────────────

  /** The decisive call: after it is sent, a lost answer means the post may exist. */
  private async createPost(
    input: PublishInput,
    mediaIds: string[],
  ): Promise<PublishOutcome> {
    const text = input.text?.trim() ? input.text : undefined;
    if (!text && mediaIds.length === 0)
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        'An X post needs text or media',
      );
    const created = await this.api.postJson<XTweetCreateResponse>(
      'x.tweet_create',
      X_ENDPOINTS.tweets,
      input.account.accessToken,
      {
        ...(text ? { text } : {}),
        ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}),
      },
      { decisive: true, signal: input.signal },
    );
    const username = input.account.metadata.username;
    return {
      status: 'published',
      providerPostId: created.data.id,
      permalink: X_ENDPOINTS.permalink(
        typeof username === 'string' && username ? username : undefined,
        created.data.id,
      ),
    };
  }

  // ───────────────────────── Media ─────────────────────────

  /** One-shot multipart upload. Images are small (≤ 5 MB), so reading them whole is fine. */
  private async uploadImage(
    input: PublishInput,
    image: PublishMedia,
  ): Promise<string> {
    return this.media.withLocalFile(
      image.objectKey,
      input.signal,
      async (file) => {
        if (file.sizeBytes > MAX_IMAGE_BYTES)
          throw new SocialProviderError(
            'INVALID_MEDIA',
            `Image is ${file.sizeBytes} bytes; X accepts at most ${MAX_IMAGE_BYTES}`,
          );
        const body = new FormData();
        body.append(
          'media',
          new Blob([new Uint8Array(await file.read())], {
            type: image.mimeType,
          }),
          'media',
        );
        body.append('media_category', 'tweet_image');
        const uploaded = await this.api.postMultipart<XMediaResponse>(
          'x.media_upload',
          X_ENDPOINTS.mediaUpload,
          input.account.accessToken,
          body,
          { signal: input.signal, timeoutMs: this.uploadTimeoutMs },
        );
        return uploaded.data.id;
      },
    );
  }

  /** Chunked upload: initialize, append each ≤ 4 MiB segment streamed from disk, finalize. */
  private async uploadVideo(
    input: PublishInput,
    video: PublishMedia,
  ): Promise<XMediaResponse> {
    const token = input.account.accessToken;
    const signal = input.signal;
    return this.media.withLocalFile(video.objectKey, signal, async (file) => {
      if (file.sizeBytes === 0 || file.sizeBytes > MAX_VIDEO_BYTES)
        throw new SocialProviderError(
          'INVALID_MEDIA',
          `Video is ${file.sizeBytes} bytes; X accepts 1 to ${MAX_VIDEO_BYTES}`,
        );
      const initialized = await this.api.postJson<XMediaResponse>(
        'x.media_initialize',
        X_ENDPOINTS.mediaInitialize,
        token,
        {
          media_type: video.mimeType,
          total_bytes: file.sizeBytes,
          media_category: 'tweet_video',
        },
        { signal },
      );
      const mediaId = initialized.data.id;
      const segments = Math.ceil(file.sizeBytes / CHUNK_BYTES);
      for (let index = 0; index < segments; index++) {
        const start = index * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, file.sizeBytes) - 1;
        const body = new FormData();
        body.append('segment_index', String(index));
        body.append('media', await readChunk(file, start, end), 'chunk');
        await this.api.postMultipart(
          'x.media_append',
          X_ENDPOINTS.mediaAppend(mediaId),
          token,
          body,
          { signal, timeoutMs: this.uploadTimeoutMs },
        );
      }
      return this.api.postEmpty<XMediaResponse>(
        'x.media_finalize',
        X_ENDPOINTS.mediaFinalize(mediaId),
        token,
        { signal },
      );
    });
  }

  private get uploadTimeoutMs(): number {
    return Math.max(this.config.timeoutMs, MIN_UPLOAD_TIMEOUT_MS);
  }
}

/** Reads the inclusive byte range [start, end] from disk into one Blob (one chunk in memory). */
async function readChunk(
  file: LocalMedia,
  start: number,
  end: number,
): Promise<Blob> {
  const parts: Uint8Array[] = [];
  for await (const part of file.stream(start, end)) parts.push(part);
  return new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
}

/**
 * Seconds until the next status check, or null when processing is done (or never needed).
 * A failed state is a rejected file: nothing was posted.
 */
function pendingCheck(info: XProcessingInfo | undefined): number | null {
  if (!info || info.state === 'succeeded') return null;
  if (info.state === 'failed')
    throw new SocialProviderError(
      'INVALID_MEDIA',
      `X could not process the media: ${info.error?.name ?? ''} ${info.error?.message ?? ''}`.trim(),
    );
  return Math.max(1, info.check_after_secs ?? VIDEO_CHECK_SECONDS);
}

const mediaIdsOf = (
  metadata: Record<string, unknown>,
  fallback: string,
): string[] => {
  const ids = metadata.mediaIds;
  return Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === 'string')
    ? (ids as string[])
    : [fallback];
};

export function xCapabilities(configured: boolean): PlatformCapabilities {
  return {
    platform: 'x',
    configured,
    textOnly: true,
    images: true,
    carousel: true,
    video: true,
    shortVideo: true,
    maxImages: 4,
    minCarouselImages: 2,
    maxCaptionLength: 280,
    titleRequired: false,
    maxTitleLength: 0,
    imageContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    videoContentTypes: ['video/mp4', 'video/quicktime'],
    maxImageBytes: MAX_IMAGE_BYTES,
    maxVideoBytes: MAX_VIDEO_BYTES,
    minVideoDurationSeconds: 1,
    maxVideoDurationSeconds: 140,
    restrictions: [
      'X counts characters with weighting (some characters count double) and every link as 23 characters. Premium accounts can post longer text, but posts are validated against 280.',
      'Your X API access tier limits how many posts can be published.',
      'X API usage is billed per plan; every API call counts towards it.',
    ],
  };
}
