import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  CheckPublicationInput,
  ConnectedAccounts,
  DeletePostInput,
  MetricsInput,
  PostMetrics,
  PublishInput,
  PublishOutcome,
  RefreshResult,
  SocialPublishingPort,
} from '../../ports.js';
import type { SocialObserverPort } from '../../ports.js';
import type { PlatformCapabilities } from '../../../helper.js';
import { SocialProviderError } from '../../../helper.js';
import type { AuthorizedAccount } from '../../../helper.js';
import { MetaApiClient } from './meta-api.client.js';
import { metaCapabilities } from './meta.mapper.js';
import { MetaOAuthService } from './meta-oauth.service.js';
import type { InstagramContainerStatus, MetaConfig } from './meta.types.js';

const IMAGE_CHECK_SECONDS = 10;
const VIDEO_CHECK_SECONDS = 30;

const requireMetadata = (account: AuthorizedAccount, key: string): string => {
  const value = account.metadata[key];
  if (typeof value !== 'string' || !value)
    throw new SocialProviderError(
      'AUTH_EXPIRED',
      `Connection ${account.connectionId} has no ${key}; reconnect required`,
    );
  return value;
};

/**
 * Facebook Pages and Instagram professional accounts through Meta's Graph API.
 * Instagram is two-phase (media container, then media_publish); only media_publish and the Page
 * post calls are decisive. Reels and processing containers are finished by status checks, never
 * by holding a request open.
 */
export class MetaSocialAdapter implements SocialPublishingPort {
  readonly provider = 'meta' as const;
  readonly platforms = ['facebook', 'instagram'] as const;
  private readonly api: MetaApiClient;
  private readonly oauth: MetaOAuthService;

  constructor(
    private readonly config: MetaConfig,
    observer: SocialObserverPort,
  ) {
    this.api = new MetaApiClient(config, observer);
    this.oauth = new MetaOAuthService(config, this.api);
  }

  isConfigured(): boolean {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  async getAuthorizationUrl(input: AuthorizationInput): Promise<string> {
    return this.oauth.authorizationUrl(input);
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccounts> {
    return { accounts: await this.oauth.exchange(input) };
  }

  /** Page tokens from a long-lived user token do not expire. */
  async refreshConnection(): Promise<RefreshResult | null> {
    return null;
  }

  /**
   * Nothing to revoke per Page: Meta grants are per user and app, and revoking the grant would
   * disconnect every Page the user shared. Disconnecting deletes our stored token; the user can
   * remove the app in Facebook settings to revoke the grant itself.
   */
  async revokeConnection(): Promise<void> {}

  async getCapabilities(): Promise<PlatformCapabilities[]> {
    return metaCapabilities(this.isConfigured());
  }

  publish(input: PublishInput): Promise<PublishOutcome> {
    return input.platform === 'facebook'
      ? this.publishFacebook(input)
      : this.publishInstagram(input);
  }

  async checkPublication(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    if (input.platform === 'facebook') return this.checkFacebookReel(input);
    return this.finishInstagram(input, input.providerRef, VIDEO_CHECK_SECONDS);
  }

  async delete(input: DeletePostInput): Promise<void> {
    if (input.platform !== 'facebook')
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        'Instagram posts cannot be deleted through the API',
      );
    await this.api.delete(
      'facebook.delete',
      input.providerPostId,
      input.account.accessToken,
      input.signal,
    );
  }

  async getMetrics(input: MetricsInput): Promise<PostMetrics> {
    const token = input.account.accessToken;
    if (input.platform === 'instagram') {
      const media = await this.api.get<{
        like_count?: number;
        comments_count?: number;
      }>(
        'instagram.metrics',
        input.providerPostId,
        token,
        { fields: 'like_count,comments_count' },
        input.signal,
      );
      return { likes: media.like_count, comments: media.comments_count };
    }
    const post = await this.api.get<{
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    }>(
      'facebook.metrics',
      input.providerPostId,
      token,
      {
        fields:
          'reactions.summary(total_count),comments.summary(total_count),shares',
      },
      input.signal,
    );
    return {
      likes: post.reactions?.summary?.total_count,
      comments: post.comments?.summary?.total_count,
      shares: post.shares?.count,
    };
  }

  // ───────────────────────── Facebook Pages ─────────────────────────

  private async publishFacebook(input: PublishInput): Promise<PublishOutcome> {
    const pageId = requireMetadata(input.account, 'pageId');
    const token = input.account.accessToken;
    const message = input.text ?? '';
    const images = input.media.filter((item) => item.type === 'image');
    const video = input.media.find((item) => item.type === 'video');
    const signal = input.signal;

    if (video) {
      if (input.settings.asReel === true)
        return this.publishFacebookReel(input, pageId, video.url);
      const created = await this.api.post<{ id: string }>(
        'facebook.video',
        `${this.api.videoUrl}/${pageId}/videos`,
        token,
        { file_url: video.url, description: message, title: input.title },
        { decisive: true, signal },
      );
      return {
        status: 'published',
        providerPostId: created.id,
        permalink: `https://www.facebook.com/${pageId}/videos/${created.id}`,
      };
    }
    if (images.length === 1) {
      const photo = await this.api.post<{ id: string; post_id?: string }>(
        'facebook.photo',
        `${this.api.graphUrl}/${pageId}/photos`,
        token,
        { url: images[0]?.url, message, published: 'true' },
        { decisive: true, signal },
      );
      return this.facebookPublished(photo.post_id ?? photo.id);
    }
    const attached: string[] = [];
    for (const image of images) {
      // Unpublished photos are invisible until attached to the feed post below.
      const photo = await this.api.post<{ id: string }>(
        'facebook.photo_unpublished',
        `${this.api.graphUrl}/${pageId}/photos`,
        token,
        { url: image.url, published: 'false', temporary: 'true' },
        { signal },
      );
      attached.push(photo.id);
    }
    const params: Record<string, string> = { message };
    attached.forEach((id, index) => {
      params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
    });
    const post = await this.api.post<{ id: string }>(
      'facebook.feed',
      `${this.api.graphUrl}/${pageId}/feed`,
      token,
      params,
      { decisive: true, signal },
    );
    return this.facebookPublished(post.id);
  }

  private async publishFacebookReel(
    input: PublishInput,
    pageId: string,
    videoUrl: string,
  ): Promise<PublishOutcome> {
    const token = input.account.accessToken;
    const started = await this.api.post<{
      video_id: string;
      upload_url: string;
    }>(
      'facebook.reel_start',
      `${this.api.graphUrl}/${pageId}/video_reels`,
      token,
      { upload_phase: 'start' },
      { signal: input.signal },
    );
    // Meta pulls the file from our delivery URL; nothing is streamed through this process.
    await this.api.http.json(
      {
        operation: 'facebook.reel_upload',
        method: 'POST',
        url: started.upload_url,
        headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
        signal: input.signal,
      },
      (response, request) =>
        new SocialProviderError(
          'INVALID_MEDIA',
          `${request.operation}: ${response.status}`,
          {
            httpStatus: response.status,
            providerRequestId: response.requestId,
          },
        ),
    );
    await this.api.post<{ success: boolean }>(
      'facebook.reel_finish',
      `${this.api.graphUrl}/${pageId}/video_reels`,
      token,
      {
        upload_phase: 'finish',
        video_id: started.video_id,
        video_state: 'PUBLISHED',
        description: input.text ?? '',
      },
      { decisive: true, signal: input.signal },
    );
    return {
      status: 'processing',
      providerRef: started.video_id,
      checkAfterSeconds: VIDEO_CHECK_SECONDS,
      metadata: { pageId },
    };
  }

  private async checkFacebookReel(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    const video = await this.api.get<{
      status?: {
        video_status?: string;
        publishing_phase?: { status?: string };
        processing_phase?: { status?: string };
      };
      permalink_url?: string;
    }>(
      'facebook.reel_status',
      input.providerRef,
      input.account.accessToken,
      { fields: 'status,permalink_url' },
      input.signal,
    );
    const status = video.status;
    if (
      status?.video_status === 'error' ||
      status?.processing_phase?.status === 'error'
    )
      throw new SocialProviderError(
        'INVALID_MEDIA',
        'Facebook could not process the reel',
      );
    if (
      status?.publishing_phase?.status === 'complete' ||
      status?.video_status === 'ready'
    )
      return {
        status: 'published',
        providerPostId: input.providerRef,
        permalink: video.permalink_url
          ? new URL(video.permalink_url, 'https://www.facebook.com').toString()
          : undefined,
      };
    return {
      status: 'processing',
      providerRef: input.providerRef,
      checkAfterSeconds: VIDEO_CHECK_SECONDS,
    };
  }

  private facebookPublished(postId: string): PublishOutcome {
    return {
      status: 'published',
      providerPostId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    };
  }

  // ───────────────────────── Instagram ─────────────────────────

  private async publishInstagram(input: PublishInput): Promise<PublishOutcome> {
    const igUserId = requireMetadata(input.account, 'igUserId');
    const token = input.account.accessToken;
    const signal = input.signal;
    const caption = input.text ?? '';
    const images = input.media.filter((item) => item.type === 'image');
    const video = input.media.find((item) => item.type === 'video');
    const media = `${this.api.graphUrl}/${igUserId}/media`;

    if (video) {
      const container = await this.api.post<{ id: string }>(
        'instagram.reel_container',
        media,
        token,
        {
          media_type: 'REELS',
          video_url: video.url,
          caption,
          share_to_feed: String(input.settings.shareToFeed !== false),
          cover_url: input.thumbnail?.url,
        },
        { signal },
      );
      return {
        status: 'processing',
        providerRef: container.id,
        checkAfterSeconds: VIDEO_CHECK_SECONDS,
        metadata: { igUserId },
      };
    }
    if (images.length === 0)
      throw new SocialProviderError(
        'UNSUPPORTED_CONTENT',
        'Instagram posts need an image or a video',
      );
    let containerId: string;
    if (images.length === 1) {
      containerId = (
        await this.api.post<{ id: string }>(
          'instagram.image_container',
          media,
          token,
          { image_url: images[0]?.url, caption },
          { signal },
        )
      ).id;
    } else {
      const children: string[] = [];
      for (const image of images) {
        children.push(
          (
            await this.api.post<{ id: string }>(
              'instagram.carousel_item',
              media,
              token,
              { image_url: image.url, is_carousel_item: 'true' },
              { signal },
            )
          ).id,
        );
      }
      containerId = (
        await this.api.post<{ id: string }>(
          'instagram.carousel_container',
          media,
          token,
          { media_type: 'CAROUSEL', children: children.join(','), caption },
          { signal },
        )
      ).id;
    }
    return this.finishInstagram(input, containerId, IMAGE_CHECK_SECONDS);
  }

  /** Publishes the container once Instagram has finished processing it; otherwise check later. */
  private async finishInstagram(
    input: PublishInput,
    containerId: string,
    checkAfterSeconds: number,
  ): Promise<PublishOutcome> {
    const igUserId = requireMetadata(input.account, 'igUserId');
    const token = input.account.accessToken;
    const container = await this.api.get<{
      status_code?: InstagramContainerStatus;
      status?: string;
    }>(
      'instagram.container_status',
      containerId,
      token,
      { fields: 'status_code,status' },
      input.signal,
    );
    switch (container.status_code) {
      case 'IN_PROGRESS':
      case undefined:
        return {
          status: 'processing',
          providerRef: containerId,
          checkAfterSeconds,
          metadata: { igUserId },
        };
      case 'ERROR':
      case 'EXPIRED':
        throw new SocialProviderError(
          'INVALID_MEDIA',
          `Instagram container ${container.status_code}: ${container.status ?? ''}`,
        );
      case 'PUBLISHED':
        // Published by an earlier run whose result was never recorded.
        return {
          status: 'published',
          providerPostId: `container:${containerId}`,
        };
      case 'FINISHED':
        break;
    }
    const published = await this.api.post<{ id: string }>(
      'instagram.media_publish',
      `${this.api.graphUrl}/${igUserId}/media_publish`,
      token,
      { creation_id: containerId },
      { decisive: true, signal: input.signal },
    );
    const permalink = await this.api
      .get<{ permalink?: string }>(
        'instagram.permalink',
        published.id,
        token,
        { fields: 'permalink' },
        input.signal,
      )
      .then((media) => media.permalink)
      .catch(() => undefined); // cosmetic: the post is live either way
    return { status: 'published', providerPostId: published.id, permalink };
  }
}
