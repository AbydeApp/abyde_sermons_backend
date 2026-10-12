import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../../shared/application/ports/clock.port.js';
import {
  STORAGE,
  type StoragePort,
} from '../../../shared/application/ports/storage.port.js';
import { deterministicId } from '../../../shared/domain/id.js';
import {
  MEDIA_ASSET_REPOSITORY,
  type MediaAssetRepositoryPort,
} from '../../brand/application/ports/out/brand.ports.js';
import {
  generatedAssetKey,
  type MediaAsset,
} from '../../brand/domain/media-asset.js';
import type {
  ReelMediaPort,
  RenderedReel,
  StoredReelMedia,
} from '../application/ports/out/reel.ports.js';

const URL_TTL_SECONDS = 60 * 60;

/** Reel output lives with Brand Studio's generated media, so social posts can carry it. */
@Injectable()
export class ReelMediaAdapter implements ReelMediaPort {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async store(input: {
    churchId: string;
    sermonId: string;
    reelId: string;
    renderAttempt: number;
    rendered: RenderedReel;
    signal?: AbortSignal;
  }): Promise<StoredReelMedia> {
    const { churchId, sermonId, reelId, renderAttempt, rendered } = input;
    const seed = `reel:${reelId}:${renderAttempt}`;
    const videoId = deterministicId(`${seed}:video`);
    const thumbnailId = deterministicId(`${seed}:thumbnail`);
    const videoKey = generatedAssetKey(
      churchId,
      sermonId,
      'VIDEO',
      videoId,
      'mp4',
    );
    const thumbnailKey = generatedAssetKey(
      churchId,
      sermonId,
      'THUMBNAIL',
      thumbnailId,
      'jpg',
    );
    const video = await this.storage.putObject({
      key: videoKey,
      contentType: rendered.contentType,
      filePath: rendered.filePath,
      signal: input.signal,
    });
    const thumbnail = await this.storage.putObject({
      key: thumbnailKey,
      contentType: rendered.thumbnail.contentType,
      filePath: rendered.thumbnail.filePath,
      signal: input.signal,
    });
    // A retry after the rows were written finds them and leaves them as they are.
    const existing = new Set(
      (await this.assets.findByIds(churchId, [videoId, thumbnailId])).map(
        (asset) => asset.id,
      ),
    );
    const now = this.clock.now();
    const asset = (
      fields: Pick<
        MediaAsset,
        | 'id'
        | 'kind'
        | 'objectKey'
        | 'contentType'
        | 'sizeBytes'
        | 'width'
        | 'height'
        | 'durationMs'
        | 'position'
      >,
    ): MediaAsset => ({
      ...fields,
      churchId,
      sermonId,
      contentItemId: null,
      status: 'READY',
      renderGroupId: deterministicId(seed),
      renderSpec: null,
      metadata: { reelId, renderAttempt },
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    const rows = [
      asset({
        id: videoId,
        kind: 'VIDEO',
        objectKey: videoKey,
        contentType: rendered.contentType,
        sizeBytes: video.sizeBytes,
        width: rendered.width,
        height: rendered.height,
        durationMs: rendered.durationMs,
        position: 0,
      }),
      asset({
        id: thumbnailId,
        kind: 'THUMBNAIL',
        objectKey: thumbnailKey,
        contentType: rendered.thumbnail.contentType,
        sizeBytes: thumbnail.sizeBytes,
        width: rendered.thumbnail.width,
        height: rendered.thumbnail.height,
        durationMs: null,
        position: 1,
      }),
    ].filter((row) => !existing.has(row.id));
    if (rows.length > 0) await this.assets.createMany(rows);
    return {
      videoAssetId: videoId,
      thumbnailAssetId: thumbnailId,
      videoSizeBytes: video.sizeBytes,
      thumbnailSizeBytes: thumbnail.sizeBytes,
    };
  }

  async discard(churchId: string, assetIds: string[]): Promise<void> {
    for (const asset of await this.assets.findByIds(churchId, assetIds)) {
      await this.assets.delete(churchId, asset.id);
      await this.storage.deleteObject(asset.objectKey);
    }
  }

  async url(churchId: string, assetId: string): Promise<string | null> {
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset || asset.status !== 'READY') return null;
    return this.storage.createDownloadUrl(asset.objectKey, URL_TTL_SECONDS);
  }
}
