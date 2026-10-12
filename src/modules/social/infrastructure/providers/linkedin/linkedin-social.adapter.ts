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
} from '../../../application/ports/out/social-publishing.port.js';
import type { SocialObserverPort } from '../../../application/ports/out/social-support.ports.js';
import type { PlatformCapabilities } from '../../../domain/capabilities.js';
import type { AuthorizedAccount } from '../../../domain/social-connection.js';
import { SocialProviderError } from '../../../domain/social-errors.js';
import type { LocalMedia, MediaFiles } from '../shared/media-download.js';
import { bearer } from '../shared/social-http.client.js';
import { LinkedInApiClient } from './linkedin-api.client.js';
import { LinkedInOAuthService } from './linkedin-oauth.service.js';
import type {
  LinkedInConfig,
  LinkedInImageUpload,
  LinkedInPostContent,
  LinkedInSocialActions,
  LinkedInVideo,
  LinkedInVideoUpload,
  LinkedInVisibility,
} from './linkedin.types.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 8 * MB;
const MAX_VIDEO_BYTES = 5 * GB;
const VIDEO_CHECK_SECONDS = 20;
const VISIBILITIES = new Set<LinkedInVisibility>([
  'PUBLIC',
  'CONNECTIONS',
  'LOGGED_IN',
]);

/**
 * Characters reserved by LinkedIn's "little" text format (Posts API `commentary`). Each must be
 * backslash-escaped to appear literally, even when it does not form a mention or template.
 */
const LITTLE_RESERVED = /[\\|{}@[\]()<>#*_~]/g;
/** `#word` at the start of the text or after whitespace: kept as a real, clickable hashtag. */
const HASHTAG = /(^|\s)#([\p{L}\p{N}_]+)/gu;

/**
 * Escapes free text for `commentary`. Hashtags are rewritten to LinkedIn's hashtag template so
 * they stay clickable; everything else (mentions syntax included) is literal text.
 */
export function escapeLittleText(text: string): string {
  const escape = (value: string) =>
    value.replace(LITTLE_RESERVED, (char) => `\\${char}`);
  let result = '';
  let last = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const [whole, lead = '', tag = ''] = match;
    result += `${escape(text.slice(last, match.index))}${lead}{hashtag|\\#|${escape(tag)}}`;
    last = match.index + whole.length;
  }
  return result + escape(text.slice(last));
}

export const linkedInPermalink = (postUrn: string) =>
  `https://www.linkedin.com/feed/update/${postUrn}/`;

const authorUrnOf = (account: AuthorizedAccount): string => {
  const value = account.metadata.authorUrn;
  if (
    typeof value !== 'string' ||
    !/^urn:li:(person|organization):/.test(value)
  )
    throw new SocialProviderError(
      'AUTH_EXPIRED',
      `Connection ${account.connectionId} has no authorUrn; reconnect required`,
    );
  return value;
};

const unsupported = (message: string) =>
  new SocialProviderError('UNSUPPORTED_CONTENT', message);

/**
 * LinkedIn member profiles and (with Community Management API access) company Pages through the
 * versioned REST API. Media is uploaded as bytes (images whole, videos in the ~4 MB parts LinkedIn
 * assigns, streamed from scratch disk); only `POST /rest/posts` is decisive. Videos are posted
 * once LinkedIn has finished processing them, via `checkPublication`.
 */
export class LinkedInSocialAdapter implements SocialPublishingPort {
  readonly provider = 'linkedin' as const;
  readonly platforms = ['linkedin'] as const;
  private readonly api: LinkedInApiClient;
  private readonly oauth: LinkedInOAuthService;

  constructor(
    private readonly config: LinkedInConfig,
    observer: SocialObserverPort,
    private readonly media: MediaFiles,
  ) {
    this.api = new LinkedInApiClient(config, observer);
    this.oauth = new LinkedInOAuthService(config, this.api);
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

  /** Best effort: an already invalid token, or a failed revoke, must not block disconnecting. */
  async revokeConnection(account: AuthorizedAccount): Promise<void> {
    await this.api.revoke(account.accessToken).catch(() => undefined);
  }

  async getCapabilities(): Promise<PlatformCapabilities[]> {
    return linkedInCapabilities(this.isConfigured(), this.config.organizations);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const author = authorUrnOf(input.account);
    const images = input.media.filter((item) => item.type === 'image');
    const videos = input.media.filter((item) => item.type === 'video');
    if (images.length > 0 && videos.length > 0)
      throw unsupported('LinkedIn posts take images or one video, not both');
    if (videos.length > 1) throw unsupported('LinkedIn posts take one video');
    if (images.length > MAX_IMAGES)
      throw unsupported(`LinkedIn posts take at most ${MAX_IMAGES} images`);
    if (input.media.length === 0 && !input.text?.trim())
      throw unsupported('A LinkedIn text post needs text');

    const video = videos[0];
    if (video) {
      const videoUrn = await this.uploadVideo(input, author, video);
      return this.finishVideo(input, author, videoUrn);
    }
    if (images.length === 0) return this.createPost(input, author);
    const ids: string[] = [];
    // Sequential: each image is downloaded, uploaded and its scratch file removed before the next.
    for (const image of images)
      ids.push(await this.uploadImage(input, author, image));
    const [single] = ids;
    return this.createPost(
      input,
      author,
      ids.length === 1 && single
        ? { media: { id: single } }
        : { multiImage: { images: ids.map((id) => ({ id })) } },
    );
  }

  async checkPublication(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    const videoUrn =
      typeof input.providerMetadata.videoUrn === 'string'
        ? input.providerMetadata.videoUrn
        : input.providerRef;
    return this.finishVideo(input, authorUrnOf(input.account), videoUrn);
  }

  async delete(input: DeletePostInput): Promise<void> {
    await this.api.delete(
      'linkedin.delete',
      `posts/${encodeURIComponent(input.providerPostId)}`,
      input.account.accessToken,
      input.signal,
    );
  }

  async getMetrics(input: MetricsInput): Promise<PostMetrics> {
    const actions = await this.api.get<LinkedInSocialActions>(
      'linkedin.metrics',
      `socialActions/${encodeURIComponent(input.providerPostId)}`,
      input.account.accessToken,
      input.signal,
    );
    return {
      likes: actions.likesSummary?.totalLikes,
      comments: actions.commentsSummary?.aggregatedTotalComments,
    };
  }

  // ───────────────────────── Posts ─────────────────────────

  /** The decisive call. 201 with the post URN in `x-restli-id`. */
  private async createPost(
    input: PublishInput,
    author: string,
    content?: LinkedInPostContent,
  ): Promise<PublishOutcome> {
    const requested = input.settings.visibility;
    const visibility: LinkedInVisibility =
      typeof requested === 'string' &&
      VISIBILITIES.has(requested as LinkedInVisibility)
        ? (requested as LinkedInVisibility)
        : 'PUBLIC';
    const { response } = await this.api.post(
      'linkedin.create_post',
      'posts',
      input.account.accessToken,
      {
        author,
        commentary: escapeLittleText(input.text ?? ''),
        visibility,
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      },
      { decisive: true, signal: input.signal },
    );
    const postUrn = response.headers.get('x-restli-id');
    if (!postUrn)
      // LinkedIn accepted the post but did not say which one it is: it is live, id unknown.
      throw new SocialProviderError(
        'UNKNOWN',
        'linkedin.create_post: 2xx without x-restli-id',
        {
          outcome: 'unknown',
          providerRequestId: response.requestId,
          httpStatus: response.status,
        },
      );
    return {
      status: 'published',
      providerPostId: postUrn,
      permalink: linkedInPermalink(postUrn),
    };
  }

  // ───────────────────────── Media ─────────────────────────

  private async uploadImage(
    input: PublishInput,
    owner: string,
    image: PublishMedia,
  ): Promise<string> {
    if (image.sizeBytes !== undefined && image.sizeBytes > MAX_IMAGE_BYTES)
      throw new SocialProviderError(
        'INVALID_MEDIA',
        'Image exceeds the LinkedIn size limit',
      );
    const token = input.account.accessToken;
    const { body } = await this.api.post<LinkedInImageUpload>(
      'linkedin.image_initialize',
      'images?action=initializeUpload',
      token,
      { initializeUploadRequest: { owner } },
      { signal: input.signal },
    );
    const { uploadUrl, image: imageUrn } = body.value;
    await this.media.withLocalFile(
      image.objectKey,
      input.signal,
      async (file) => {
        if (file.sizeBytes === 0 || file.sizeBytes > MAX_IMAGE_BYTES)
          throw new SocialProviderError(
            'INVALID_MEDIA',
            `Image size ${file.sizeBytes} is outside LinkedIn's limits`,
          );
        // The upload URL is pre-signed; LinkedIn's examples still send the member token.
        await this.api.upload(
          'linkedin.image_upload',
          uploadUrl,
          file.stream(),
          { ...bearer(token), 'Content-Length': String(file.sizeBytes) },
          input.signal,
        );
      },
    );
    return imageUrn;
  }

  /** initializeUpload → PUT each assigned byte range (streamed from disk) → finalizeUpload. */
  private async uploadVideo(
    input: PublishInput,
    owner: string,
    video: PublishMedia,
  ): Promise<string> {
    const token = input.account.accessToken;
    return this.media.withLocalFile(
      video.objectKey,
      input.signal,
      async (file) => {
        if (file.sizeBytes === 0 || file.sizeBytes > MAX_VIDEO_BYTES)
          throw new SocialProviderError(
            'INVALID_MEDIA',
            `Video size ${file.sizeBytes} is outside LinkedIn's limits`,
          );
        const { body } = await this.api.post<LinkedInVideoUpload>(
          'linkedin.video_initialize',
          'videos?action=initializeUpload',
          token,
          {
            initializeUploadRequest: {
              owner,
              fileSizeBytes: file.sizeBytes,
              uploadCaptions: false,
              uploadThumbnail: false,
            },
          },
          { signal: input.signal },
        );
        const { video: videoUrn, uploadToken, uploadInstructions } = body.value;
        const partIds = await this.uploadParts(
          file,
          uploadInstructions,
          input.signal,
        );
        await this.api.post(
          'linkedin.video_finalize',
          'videos?action=finalizeUpload',
          token,
          {
            finalizeUploadRequest: {
              video: videoUrn,
              uploadToken: uploadToken ?? '',
              uploadedPartIds: partIds,
            },
          },
          { signal: input.signal },
        );
        return videoUrn;
      },
    );
  }

  /** Parts go up in LinkedIn's order; each response's ETag is that part's id for finalize. */
  private async uploadParts(
    file: LocalMedia,
    instructions: LinkedInVideoUpload['value']['uploadInstructions'],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const parts = [...instructions].sort((a, b) => a.firstByte - b.firstByte);
    const ids: string[] = [];
    for (const part of parts) {
      const last = Math.min(part.lastByte, file.sizeBytes - 1);
      const response = await this.api.upload(
        'linkedin.video_upload_part',
        part.uploadUrl,
        file.stream(part.firstByte, last),
        { 'Content-Length': String(last - part.firstByte + 1) },
        signal,
      );
      const etag = response.headers.get('etag');
      if (!etag)
        throw new SocialProviderError(
          'PROVIDER_UNAVAILABLE',
          'linkedin.video_upload_part: no ETag',
          {
            retryable: true,
            providerRequestId: response.requestId,
          },
        );
      ids.push(etag.replace(/^"(.*)"$/, '$1'));
    }
    return ids;
  }

  /**
   * Posts the video once LinkedIn reports it AVAILABLE; until then the publication is
   * `processing` and `checkPublication` comes back here.
   */
  private async finishVideo(
    input: PublishInput,
    author: string,
    videoUrn: string,
  ): Promise<PublishOutcome> {
    const content: LinkedInPostContent = {
      media: { id: videoUrn, ...(input.title ? { title: input.title } : {}) },
    };
    let video: LinkedInVideo;
    try {
      video = await this.api.get<LinkedInVideo>(
        'linkedin.video_status',
        `videos/${encodeURIComponent(videoUrn)}`,
        input.account.accessToken,
        input.signal,
      );
    } catch (error) {
      // Some member tokens (w_member_social only) cannot read assets. LinkedIn then accepts the
      // post as PUBLISH_REQUESTED and publishes it itself once processing completes.
      if (
        error instanceof SocialProviderError &&
        error.code === 'PERMISSION_DENIED'
      )
        return this.createPost(input, author, content);
      throw error;
    }
    switch (video.status) {
      case 'AVAILABLE':
        return this.createPost(input, author, content);
      case 'PROCESSING_FAILED':
        throw new SocialProviderError(
          'INVALID_MEDIA',
          `LinkedIn could not process the video: ${video.processingFailureReason ?? 'no reason given'}`,
        );
      default:
        return {
          status: 'processing',
          providerRef: videoUrn,
          checkAfterSeconds: VIDEO_CHECK_SECONDS,
          metadata: { videoUrn },
        };
    }
  }
}

export function linkedInCapabilities(
  configured: boolean,
  organizations: boolean,
): PlatformCapabilities[] {
  return [
    {
      platform: 'linkedin',
      configured,
      textOnly: true,
      images: true,
      carousel: true,
      video: true,
      shortVideo: true,
      maxImages: MAX_IMAGES,
      minCarouselImages: 2,
      maxCaptionLength: 3_000,
      titleRequired: false,
      maxTitleLength: 200,
      imageContentTypes: ['image/jpeg', 'image/png', 'image/gif'],
      videoContentTypes: ['video/mp4'],
      maxImageBytes: MAX_IMAGE_BYTES,
      maxVideoBytes: MAX_VIDEO_BYTES,
      minVideoDurationSeconds: 3,
      maxVideoDurationSeconds: 30 * 60,
      restrictions: [
        ...(organizations
          ? []
          : [
              'Posts to personal profiles only. Company Page posting needs LinkedIn Community Management API approval.',
            ]),
        'LinkedIn connections last 60 days. Reconnect the account before it expires.',
      ],
    },
  ];
}
