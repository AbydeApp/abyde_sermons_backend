import type {
  AccountCapabilities,
  AuthorizationCallbackInput,
  AuthorizationInput,
  CheckPublicationInput,
  ConnectedAccounts,
  PublishInput,
  PublishOutcome,
  RefreshResult,
  SocialPublishingPort,
} from '../../../application/ports/out/social-publishing.port.js';
import type { SocialObserverPort } from '../../../application/ports/out/social-support.ports.js';
import type { PlatformCapabilities } from '../../../domain/capabilities.js';
import { SocialProviderError } from '../../../domain/social-errors.js';
import type { AuthorizedAccount } from '../../../domain/social-connection.js';
import { TIKTOK_PRIVACY_LEVELS } from '../../../domain/target-settings.js';
import { TikTokApiClient } from './tiktok-api.client.js';
import { mapFailReason, TikTokApiError } from './tiktok.errors.js';
import { TikTokOAuthService } from './tiktok-oauth.service.js';
import type {
  TikTokConfig,
  TikTokCreatorInfo,
  TikTokPrivacyLevel,
  TikTokPublishStatusData,
} from './tiktok.types.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CHECK_AFTER_SECONDS = 15;
const MAX_PHOTOS = 35;
const MAX_TITLE_LENGTH = 90;

const UNAUDITED_RESTRICTION =
  'Posts are private (only you) until TikTok approves this app.';
const DOMAIN_RESTRICTION =
  'TikTok pulls media from our media domain, which must be verified in the TikTok developer portal.';
/** creator_info refusals that mean "this creator cannot post right now", not "reconnect". */
const POSTING_BLOCKED_CODES = new Set([
  'spam_risk_too_many_posts',
  'spam_risk_user_banned_from_posting',
  'reached_active_user_cap',
]);

const isPrivacyLevel = (value: unknown): value is TikTokPrivacyLevel =>
  TIKTOK_PRIVACY_LEVELS.includes(value as TikTokPrivacyLevel);

/**
 * TikTok post ids are 64-bit integers. A JSON number above 2^53 has already lost digits when it
 * was parsed, so it is not trusted as an id (the publish id is used instead).
 */
const publicPostId = (status: TikTokPublishStatusData): string | undefined => {
  const first = status.publicaly_available_post_id?.[0];
  if (typeof first === 'string' && first) return first;
  if (typeof first === 'number' && Number.isSafeInteger(first))
    return String(first);
  return undefined;
};

/**
 * TikTok through the Content Posting API (Direct Post) and Login Kit for Web.
 * TikTok pulls the media from our delivery URL; the init call is decisive (once accepted, TikTok
 * posts on its own) and the result is followed with status checks, never by holding a request
 * open. Until TikTok audits the app every post is forced to SELF_ONLY.
 *
 * Post metrics are not offered: they need the extra `video.list` scope and a public post id,
 * which unaudited (private) posts never get.
 */
export class TikTokSocialAdapter implements SocialPublishingPort {
  readonly provider = 'tiktok' as const;
  readonly platforms = ['tiktok'] as const;
  private readonly api: TikTokApiClient;
  private readonly oauth: TikTokOAuthService;

  constructor(
    private readonly config: TikTokConfig,
    observer: SocialObserverPort,
  ) {
    this.api = new TikTokApiClient(config, observer);
    this.oauth = new TikTokOAuthService(config, this.api);
  }

  isConfigured(): boolean {
    return Boolean(this.config.clientKey && this.config.clientSecret);
  }

  async getAuthorizationUrl(input: AuthorizationInput): Promise<string> {
    return this.oauth.authorizationUrl(input);
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccounts> {
    return { accounts: [await this.oauth.exchange(input)] };
  }

  refreshConnection(account: AuthorizedAccount): Promise<RefreshResult | null> {
    return this.oauth.refresh(account);
  }

  revokeConnection(account: AuthorizedAccount): Promise<void> {
    return this.oauth.revoke(account);
  }

  async getCapabilities(): Promise<PlatformCapabilities[]> {
    return [tiktokCapabilities(this.isConfigured(), this.config.audited)];
  }

  /** Per-creator options TikTok requires apps to show before posting (privacy, interactions, length). */
  async getAccountCapabilities(
    account: AuthorizedAccount,
  ): Promise<AccountCapabilities> {
    const restrictions = this.config.audited ? [] : [UNAUDITED_RESTRICTION];
    let creator: TikTokCreatorInfo;
    try {
      creator = await this.api.post<TikTokCreatorInfo>(
        'tiktok.creator_info',
        '/v2/post/publish/creator_info/query/',
        account.accessToken,
        {},
      );
    } catch (error) {
      if (
        error instanceof TikTokApiError &&
        POSTING_BLOCKED_CODES.has(error.tiktokCode)
      )
        return {
          platform: 'tiktok',
          privacyLevels: this.config.audited ? undefined : ['SELF_ONLY'],
          canPost: false,
          restrictions: [
            ...restrictions,
            'TikTok is not accepting new posts from this account right now. Try again later.',
          ],
        };
      throw error;
    }
    const offered = (creator.privacy_level_options ?? []).filter(
      isPrivacyLevel,
    );
    return {
      platform: 'tiktok',
      privacyLevels: this.config.audited ? offered : ['SELF_ONLY'],
      maxVideoDurationSeconds: creator.max_video_post_duration_sec,
      commentsDisabled: creator.comment_disabled,
      duetDisabled: creator.duet_disabled,
      stitchDisabled: creator.stitch_disabled,
      canPost: true,
      restrictions,
    };
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const video = input.media.find((item) => item.type === 'video');
    const images = input.media.filter((item) => item.type === 'image');
    if (video) return this.publishVideo(input, video.url);
    if (images.length === 0)
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        'TikTok posts need a video or at least one photo',
      );
    if (images.length > MAX_PHOTOS)
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        `TikTok photo posts take at most ${MAX_PHOTOS} images (got ${images.length})`,
      );
    return this.publishPhotos(
      input,
      images.map((image) => image.url),
    );
  }

  async checkPublication(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    const publishId = input.providerRef;
    const status = await this.api.post<TikTokPublishStatusData>(
      'tiktok.publish_status',
      '/v2/post/publish/status/fetch/',
      input.account.accessToken,
      { publish_id: publishId },
      { signal: input.signal },
    );
    switch (status.status) {
      case 'PUBLISH_COMPLETE':
        // Private (SELF_ONLY) posts have no public id; the publish id still identifies them.
        return {
          status: 'published',
          providerPostId: publicPostId(status) ?? publishId,
          metadata: { publishId },
        };
      case 'FAILED':
        throw mapFailReason(status.fail_reason, publishId);
      case 'SEND_TO_USER_INBOX':
        // Only expected for inbox uploads, which we never start: the creator must finish in the
        // app. Not public, and posting again would leave a second draft, so stop here.
        throw new SocialProviderError(
          'UNSUPPORTED_CONTENT',
          `TikTok publication ${publishId} was sent to the creator's inbox instead of being posted`,
          { retryable: false },
        );
      default:
        return {
          status: 'processing',
          providerRef: publishId,
          checkAfterSeconds: CHECK_AFTER_SECONDS,
          metadata: input.providerMetadata,
        };
    }
  }

  // ───────────────────────── Direct Post ─────────────────────────

  private async publishVideo(
    input: PublishInput,
    videoUrl: string,
  ): Promise<PublishOutcome> {
    const settings = this.postSettings(input.settings);
    const coverMs = input.settings.videoCoverTimestampMs;
    const init = await this.api.post<{ publish_id?: string }>(
      'tiktok.video_init',
      '/v2/post/publish/video/init/',
      input.account.accessToken,
      {
        post_info: {
          // TikTok shows the video "title" as its caption.
          title: input.text ?? '',
          privacy_level: settings.privacyLevel,
          disable_duet: settings.disableDuet,
          disable_comment: settings.disableComment,
          disable_stitch: settings.disableStitch,
          ...(typeof coverMs === 'number' &&
          Number.isInteger(coverMs) &&
          coverMs >= 0
            ? { video_cover_timestamp_ms: coverMs }
            : {}),
        },
        source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
      },
      { decisive: true, signal: input.signal },
    );
    return this.processing(init.publish_id, 'video');
  }

  private async publishPhotos(
    input: PublishInput,
    urls: string[],
  ): Promise<PublishOutcome> {
    const settings = this.postSettings(input.settings);
    const title = input.title?.trim();
    const init = await this.api.post<{ publish_id?: string }>(
      'tiktok.photo_init',
      '/v2/post/publish/content/init/',
      input.account.accessToken,
      {
        post_info: {
          ...(title ? { title: title.slice(0, MAX_TITLE_LENGTH) } : {}),
          description: input.text ?? '',
          privacy_level: settings.privacyLevel,
          disable_comment: settings.disableComment,
          auto_add_music: true,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: urls,
        },
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
      },
      { decisive: true, signal: input.signal },
    );
    return this.processing(init.publish_id, 'photo');
  }

  /** Validated target settings; an unaudited app may only post privately. */
  private postSettings(settings: Record<string, unknown>) {
    return {
      privacyLevel:
        this.config.audited && isPrivacyLevel(settings.privacyLevel)
          ? settings.privacyLevel
          : ('SELF_ONLY' as const),
      disableComment: settings.disableComment === true,
      disableDuet: settings.disableDuet === true,
      disableStitch: settings.disableStitch === true,
    };
  }

  private processing(
    publishId: string | undefined,
    mediaType: 'video' | 'photo',
  ): PublishOutcome {
    if (!publishId)
      // TikTok accepted the decisive call but gave us nothing to follow it with.
      throw new SocialProviderError(
        'UNKNOWN',
        `TikTok ${mediaType} init succeeded without a publish_id`,
        { outcome: 'unknown' },
      );
    return {
      status: 'processing',
      providerRef: publishId,
      checkAfterSeconds: CHECK_AFTER_SECONDS,
      metadata: { publishId, mediaType },
    };
  }
}

export function tiktokCapabilities(
  configured: boolean,
  audited: boolean,
): PlatformCapabilities {
  return {
    platform: 'tiktok',
    configured,
    textOnly: false,
    images: true,
    carousel: true,
    video: true,
    shortVideo: true,
    maxImages: MAX_PHOTOS,
    // A single photo is a valid photo post; any multi-image post (2+) is accepted.
    minCarouselImages: 2,
    maxCaptionLength: 2_200,
    titleRequired: false,
    maxTitleLength: MAX_TITLE_LENGTH,
    imageContentTypes: ['image/jpeg', 'image/webp'],
    videoContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxImageBytes: 20 * MB,
    maxVideoBytes: 4 * GB,
    minVideoDurationSeconds: 3,
    // Upper bound; each creator's own limit comes from getAccountCapabilities.
    maxVideoDurationSeconds: 600,
    restrictions: [
      ...(audited ? [] : [UNAUDITED_RESTRICTION]),
      DOMAIN_RESTRICTION,
    ],
  };
}
