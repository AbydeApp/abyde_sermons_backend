import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/domain-error.js';
import {
  capabilityViolations,
  type MediaFacts,
  type PlatformCapabilities,
} from '../domain/capabilities.js';
import type { SocialConnection } from '../domain/social-connection.js';
import {
  PLATFORM_LABELS,
  type SocialPlatform,
} from '../domain/social-platform.js';
import type { SocialPost } from '../domain/social-post.js';
import {
  SOCIAL_PROVIDER_REGISTRY,
  type SocialProviderRegistryPort,
} from './ports/out/social-publishing.port.js';
import {
  type PublishableAsset,
  SOCIAL_MEDIA_LIBRARY,
  type SocialMediaLibraryPort,
} from './ports/out/social-support.ports.js';

const POSTABLE_KINDS = new Set(['IMAGE', 'CAROUSEL_SLIDE', 'VIDEO']);

export interface MediaCheck {
  /** Ordered as the post lists them. */
  assets: PublishableAsset[];
  thumbnail?: PublishableAsset;
  pending: boolean;
}

/**
 * Validates a post before anything is queued: media belongs to the church and is publishable,
 * targets are this church's live connections, and every target's platform accepts the content
 * according to the adapter's current capabilities.
 */
@Injectable()
export class PostValidator {
  constructor(
    @Inject(SOCIAL_MEDIA_LIBRARY)
    private readonly media: SocialMediaLibraryPort,
    @Inject(SOCIAL_PROVIDER_REGISTRY)
    private readonly registry: SocialProviderRegistryPort,
  ) {}

  async loadMedia(
    churchId: string,
    mediaAssetIds: string[],
    thumbnailAssetId?: string,
  ): Promise<MediaCheck> {
    const ids = [
      ...new Set([
        ...mediaAssetIds,
        ...(thumbnailAssetId ? [thumbnailAssetId] : []),
      ]),
    ];
    const found = new Map(
      (await this.media.findAssets(churchId, ids)).map((asset) => [
        asset.id,
        asset,
      ]),
    );
    const assets = mediaAssetIds.map((id) => {
      const asset = found.get(id);
      if (!asset || !POSTABLE_KINDS.has(asset.kind))
        throw invalid('mediaAssetIds', 'Media not found');
      if (asset.status === 'FAILED')
        throw invalid(
          'mediaAssetIds',
          'Some media failed to render; render it again',
        );
      return asset;
    });
    const thumbnail = thumbnailAssetId
      ? found.get(thumbnailAssetId)
      : undefined;
    if (
      thumbnailAssetId &&
      (!thumbnail || !['THUMBNAIL', 'IMAGE'].includes(thumbnail.kind))
    )
      throw invalid('thumbnailAssetId', 'Thumbnail not found');
    return {
      assets,
      thumbnail,
      pending: [...assets, ...(thumbnail ? [thumbnail] : [])].some(
        (asset) => asset.status === 'PENDING',
      ),
    };
  }

  /** Target connections must belong to the church, be usable, and match the requested platform. */
  checkTargets(
    targets: Array<{ platform: SocialPlatform; connectionId: string }>,
    connections: SocialConnection[],
  ): void {
    const byId = new Map(
      connections.map((connection) => [connection.id, connection]),
    );
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.connectionId))
        throw invalid('targets', 'Each account can be targeted once');
      seen.add(target.connectionId);
      const connection = byId.get(target.connectionId);
      // Another church's connection is indistinguishable from a missing one.
      if (!connection) throw invalid('targets', 'Account not found');
      if (connection.platform !== target.platform)
        throw invalid(
          'targets',
          `That account is not a ${PLATFORM_LABELS[target.platform]} account`,
        );
      if (connection.status !== 'connected')
        throw new DomainError(
          'UNPROCESSABLE',
          'CONNECTION_NOT_ACTIVE',
          `Reconnect ${connection.accountName} on ${PLATFORM_LABELS[connection.platform]} first.`,
        );
    }
  }

  /** Capability check per target platform; problems are reported per platform. */
  async checkCapabilities(
    post: Pick<SocialPost, 'caption' | 'title'>,
    media: PublishableAsset[],
    platforms: SocialPlatform[],
  ): Promise<void> {
    const facts: MediaFacts[] = media.map((asset) => ({
      type: asset.contentType.startsWith('video/') ? 'video' : 'image',
      contentType: asset.contentType,
      sizeBytes: asset.status === 'READY' ? asset.sizeBytes : null,
      durationMs: asset.status === 'READY' ? asset.durationMs : null,
    }));
    const errors: Record<string, string[]> = {};
    for (const platform of new Set(platforms)) {
      const capabilities = await this.capabilitiesFor(platform);
      const problems = capabilityViolations(capabilities, {
        caption: post.caption,
        title: post.title,
        media: facts,
      });
      if (problems.length > 0) errors[`targets.${platform}`] = problems;
    }
    if (Object.keys(errors).length > 0)
      throw new DomainError(
        'UNPROCESSABLE',
        'UNSUPPORTED_FOR_PLATFORM',
        'Some platforms cannot publish this post as it is.',
        errors,
      );
  }

  async capabilitiesFor(
    platform: SocialPlatform,
  ): Promise<PlatformCapabilities> {
    const all = await this.registry.forPlatform(platform).getCapabilities();
    const capabilities = all.find((entry) => entry.platform === platform);
    if (!capabilities) throw new Error(`No capabilities for ${platform}`);
    return capabilities;
  }
}

const invalid = (field: string, message: string) =>
  new DomainError(
    'UNPROCESSABLE',
    'VALIDATION_ERROR',
    'The request could not be processed.',
    {
      [field]: [message],
    },
  );
