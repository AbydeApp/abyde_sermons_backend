import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BrandRenderingPort,
  RenderCarouselInput,
  RenderedMedia,
  RenderImageInput,
  RenderThumbnailInput,
  RenderVideoInput,
} from '../../src/modules/brand/adapters/ports.js';
import { renderCardSvg } from '../../src/modules/brand/adapters/template-svg.js';
import type {
  AuthorizationCallbackInput,
  AuthorizationInput,
  CheckPublicationInput,
  ConnectedAccount,
  ConnectedAccounts,
  PublishInput,
  PublishOutcome,
  RefreshResult,
  SocialPublishingPort,
} from '../../src/modules/social/application/ports/out/social-publishing.port.js';
import type { SocialObserverPort } from '../../src/modules/social/application/ports/out/social-support.ports.js';
import type { PlatformCapabilities } from '../../src/modules/social/domain/capabilities.js';
import type { AuthorizedAccount } from '../../src/modules/social/domain/social-connection.js';
import {
  PLATFORMS_FOR_PROVIDER,
  type SocialPlatform,
  type SocialProviderId,
} from '../../src/modules/social/domain/social-platform.js';

type Step = PublishOutcome | Error;

/** Social provider double: no network. Tests script accounts, publish outcomes and failures. */
export class FakeSocialAdapter implements SocialPublishingPort {
  readonly platforms: readonly SocialPlatform[];
  readonly published: PublishInput[] = [];
  readonly checks: CheckPublicationInput[] = [];
  readonly revoked: AuthorizedAccount[] = [];
  readonly authorizations: AuthorizationInput[] = [];
  readonly exchanges: AuthorizationCallbackInput[] = [];
  refreshes = 0;
  configured = true;
  /** Accounts the next code exchange returns (defaults to one per platform). */
  accounts: Array<
    Partial<ConnectedAccount> & { platform: SocialPlatform }
  > | null = null;
  /** Consumed in order by publish(); when empty, publishing succeeds. */
  publishSteps: Step[] = [];
  checkSteps: Step[] = [];
  refreshResult: RefreshResult | Error | null = null;

  constructor(readonly provider: SocialProviderId) {
    this.platforms = PLATFORMS_FOR_PROVIDER[provider];
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async getAuthorizationUrl(input: AuthorizationInput): Promise<string> {
    this.authorizations.push(input);
    return `https://auth.example/${this.provider}?state=${encodeURIComponent(input.state)}&scope=${input.platforms.join(',')}`;
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ConnectedAccounts> {
    this.exchanges.push(input);
    if (input.code === 'bad-code') throw new Error('exchange rejected');
    const accounts =
      this.accounts ?? input.platforms.map((platform) => ({ platform }));
    return {
      accounts: accounts.map((account, index) => ({
        providerAccountId: `${account.platform}-acct-${index + 1}`,
        accountName: `${account.platform} account ${index + 1}`,
        accessToken: `access-${input.code}-${index}`,
        refreshToken: `refresh-${input.code}-${index}`,
        scopes: ['publish'],
        metadata: {},
        ...account,
      })),
    };
  }

  async refreshConnection(): Promise<RefreshResult | null> {
    this.refreshes++;
    if (this.refreshResult instanceof Error) throw this.refreshResult;
    return this.refreshResult;
  }

  async revokeConnection(account: AuthorizedAccount): Promise<void> {
    this.revoked.push(account);
  }

  async getCapabilities(): Promise<PlatformCapabilities[]> {
    return this.platforms.map((platform) =>
      fakeCapabilities(platform, this.configured),
    );
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    this.published.push(input);
    return this.next(
      this.publishSteps,
      `${input.platform}-post-${this.published.length}`,
    );
  }

  async checkPublication(
    input: CheckPublicationInput,
  ): Promise<PublishOutcome> {
    this.checks.push(input);
    return this.next(
      this.checkSteps,
      `${input.platform}-post-checked-${this.checks.length}`,
    );
  }

  private next(steps: Step[], id: string): PublishOutcome {
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return (
      step ?? {
        status: 'published',
        providerPostId: id,
        permalink: `https://social.example/${id}`,
      }
    );
  }
}

/** Generous, permissive capabilities, varying only where tests need platform differences. */
export function fakeCapabilities(
  platform: SocialPlatform,
  configured = true,
): PlatformCapabilities {
  const videoOnly = platform === 'youtube';
  const needsMedia =
    platform === 'instagram' || platform === 'tiktok' || videoOnly;
  return {
    platform,
    configured,
    textOnly: !needsMedia,
    images: !videoOnly,
    carousel: !videoOnly,
    video: true,
    shortVideo: true,
    maxImages: platform === 'x' ? 4 : 10,
    minCarouselImages: 2,
    maxCaptionLength: platform === 'x' ? 280 : 2200,
    titleRequired: videoOnly,
    maxTitleLength: videoOnly ? 100 : 0,
    imageContentTypes: ['image/jpeg', 'image/png'],
    videoContentTypes: ['video/mp4'],
    maxImageBytes: 8 * 1024 ** 2,
    maxVideoBytes: 1024 ** 3,
    minVideoDurationSeconds: 3,
    maxVideoDurationSeconds: 600,
    restrictions: [],
  };
}

export const recordingSocialObserver = (): SocialObserverPort & {
  events: unknown[];
} => {
  const events: unknown[] = [];
  return {
    events,
    providerCall: (event) => void events.push({ type: 'call', ...event }),
    publication: (event) => void events.push({ type: 'publication', ...event }),
    tokenRefresh: (event) => void events.push({ type: 'refresh', ...event }),
  };
};

/** Renderer double: writes small placeholder files (the SVG for cards) without sharp or ffmpeg. */
export class FakeBrandRenderer implements BrandRenderingPort {
  readonly images: RenderImageInput[] = [];
  readonly videos: RenderVideoInput[] = [];
  failVideos = false;

  async renderImage(input: RenderImageInput): Promise<RenderedMedia> {
    this.images.push(input);
    const filePath = join(input.workDir, `${input.name}.jpg`);
    await writeFile(filePath, renderCardSvg(input.card));
    return {
      filePath,
      contentType: 'image/jpeg',
      width: input.card.width,
      height: input.card.height,
    };
  }

  async renderCarousel(input: RenderCarouselInput): Promise<RenderedMedia[]> {
    const rendered: RenderedMedia[] = [];
    for (const [index, card] of input.cards.entries())
      rendered.push(
        await this.renderImage({
          ...input,
          card,
          name: `${input.name}-${index}`,
        }),
      );
    return rendered;
  }

  async renderVideo(input: RenderVideoInput): Promise<RenderedMedia> {
    this.videos.push(input);
    if (this.failVideos) throw new Error('ffmpeg crashed');
    const filePath = join(input.workDir, `${input.name}.mp4`);
    await writeFile(filePath, Buffer.alloc(1024, 1));
    return {
      filePath,
      contentType: 'video/mp4',
      width: input.width,
      height: input.height,
      durationMs: input.endMs - input.startMs,
    };
  }

  async renderThumbnail(input: RenderThumbnailInput): Promise<RenderedMedia> {
    const filePath = join(input.workDir, `${input.name}.jpg`);
    await writeFile(filePath, Buffer.alloc(256, 2));
    return { filePath, contentType: 'image/jpeg', width: 1080, height: 1920 };
  }
}
