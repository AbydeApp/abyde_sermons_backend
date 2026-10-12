import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE,
  type StoragePort,
} from '../../../shared/application/ports/storage.port.js';
import {
  MEDIA_ASSET_REPOSITORY,
  type MediaAssetRepositoryPort,
} from '../../brand/application/ports/out/brand.ports.js';
import type {
  PublishableAsset,
  SocialMediaLibraryPort,
} from '../application/ports/out/social-support.ports.js';

/** Adapter from the social module onto Brand Studio's media assets (one-way dependency). */
@Injectable()
export class SocialMediaLibraryAdapter implements SocialMediaLibraryPort {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async findAssets(
    churchId: string,
    ids: string[],
  ): Promise<PublishableAsset[]> {
    return (await this.assets.findByIds(churchId, ids)).map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      status: asset.status,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
    }));
  }

  deliveryUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.storage.createDeliveryUrl(objectKey, ttlSeconds);
  }
}
