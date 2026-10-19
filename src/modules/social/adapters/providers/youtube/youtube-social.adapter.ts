import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
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
import type { MediaFiles } from '../shared/media-download.js';
import {
  GoogleOAuthService,
  YOUTUBE_MANAGE_SCOPES,
} from './google-oauth.service.js';
import { YouTubeApiClient } from './youtube-api.client.js';
import { isVideoNotFound } from './youtube.errors.js';
import {
  toVideoResource,
  YouTubeUploadService,
} from './youtube-upload.service.js';
import type {
  YouTubeAdapterOptions,
  YouTubeConfig,
  YouTubeList,
  YouTubeVideo,
} from './youtube.types.js';

const GB = 1024 ** 3;
/** YouTube shows vertical or square videos up to this length as Shorts (no separate API). */
const SHORTS_MAX_SECONDS = 180;

/**
 * YouTube channels through Google OAuth 2.0 and the YouTube Data API v3. A publish is one
 * synchronous resumable upload inside the worker job (no status polling, so no
 * `checkPublication`); the final upload chunk is the decisive call. The custom thumbnail is set
 * afterwards, best effort.
 */
export class YouTubeSocialAdapter implements SocialPublishingPort {
  readonly provider = 'youtube' as const;
  readonly platforms = ['youtube'] as const;
  private readonly api: YouTubeApiClient;
  private readonly oauth: GoogleOAuthService;
  private readonly uploads: YouTubeUploadService;

  constructor(
    private readonly config: YouTubeConfig,
    observer: SocialObserverPort,
    media: MediaFiles,
    options: YouTubeAdapterOptions = {},
  ) {
    this.api = new YouTubeApiClient(config, observer);
    this.oauth = new GoogleOAuthService(config, this.api);
    this.uploads = new YouTubeUploadService(
      this.api,
      media,
      options.chunkSizeBytes,
    );
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
    return [youtubeCapabilities(this.isConfigured())];
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const video = requireSingleVideo(input);
    // Validated before any provider call, so a bad title or missing answer never opens a session.
    const resource = toVideoResource(input);
    const token = input.account.accessToken;
    const uploaded = await this.uploads.uploadVideo({
      token,
      video,
      resource,
      signal: input.signal,
    });
    // ── The video exists from here on: nothing below may fail the publication. ──
    const thumbnail = input.thumbnail
      ? await this.uploads.setThumbnail(
          token,
          uploaded.id,
          input.thumbnail,
          input.signal,
        )
      : undefined;
    return {
      status: 'published',
      providerPostId: uploaded.id,
      permalink: isLikelyShort(video)
        ? `https://www.youtube.com/shorts/${uploaded.id}`
        : `https://www.youtube.com/watch?v=${uploaded.id}`,
      metadata: {
        privacyStatus:
          uploaded.status?.privacyStatus ?? resource.status.privacyStatus,
        ...thumbnail,
      },
    };
  }

  /**
   * `videos.delete` needs a full-management scope we deliberately do not request (least
   * privilege), so connections made through our consent screen cannot delete: the church removes
   * the video in YouTube Studio. If a broader scope was granted to our client, the call is made.
   */
  async delete(input: DeletePostInput): Promise<void> {
    if (
      !input.account.scopes.some((scope) =>
        YOUTUBE_MANAGE_SCOPES.includes(scope),
      )
    )
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        'Deleting YouTube videos needs a channel management scope that is not requested',
      );
    try {
      await this.api.delete(
        'youtube.delete',
        'videos',
        input.account.accessToken,
        { id: input.providerPostId },
        input.signal,
      );
    } catch (error) {
      if (isVideoNotFound(error)) return; // already gone: delete is idempotent
      throw error;
    }
  }

  async getMetrics(input: MetricsInput): Promise<PostMetrics> {
    const videos = await this.api.get<YouTubeList<YouTubeVideo>>(
      'youtube.metrics',
      'videos',
      input.account.accessToken,
      { part: 'statistics', id: input.providerPostId },
      input.signal,
    );
    const statistics = videos.items?.[0]?.statistics;
    return {
      views: count(statistics?.viewCount),
      likes: count(statistics?.likeCount),
      comments: count(statistics?.commentCount),
    };
  }
}

const requireSingleVideo = (input: PublishInput): PublishMedia => {
  const videos = input.media.filter((item) => item.type === 'video');
  const [video] = videos;
  if (!video || videos.length !== 1 || videos.length !== input.media.length)
    throw new SocialProviderError(
      'UNSUPPORTED_CONTENT',
      'A YouTube post needs exactly one video and no images',
    );
  return video;
};

/** Cosmetic only (which permalink to show); YouTube alone decides what is a Short. */
const isLikelyShort = (video: PublishMedia): boolean =>
  video.durationSeconds !== undefined &&
  video.durationSeconds <= SHORTS_MAX_SECONDS &&
  video.width !== undefined &&
  video.height !== undefined &&
  video.height >= video.width;

/** Counters arrive as strings; hidden ones (e.g. likes) are absent. */
const count = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function youtubeCapabilities(configured: boolean): PlatformCapabilities {
  return {
    platform: 'youtube',
    configured,
    textOnly: false,
    images: false,
    carousel: false,
    video: true,
    shortVideo: true,
    maxImages: 0,
    minCarouselImages: 0,
    maxCaptionLength: 5000,
    titleRequired: true,
    maxTitleLength: 100,
    imageContentTypes: [],
    videoContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxImageBytes: 0,
    // YouTube accepts 256 GB, but the whole upload must finish inside one `social-publish` job
    // (20 minutes); 4 GB needs a sustained ~3.5 MB/s, and generated clips are far smaller.
    maxVideoBytes: 4 * GB,
    minVideoDurationSeconds: 1,
    maxVideoDurationSeconds: 12 * 60 * 60,
    restrictions: [
      'Until our Google app passes its YouTube API audit, uploaded videos stay private.',
      'Videos longer than 15 minutes and custom thumbnails need a verified YouTube channel.',
      'Uploads share a daily YouTube API quota (each upload uses a large share of it); when it is used up, publishing resumes after midnight Pacific time.',
      'Vertical or square videos up to 3 minutes are shown as Shorts automatically.',
    ],
  };
}
