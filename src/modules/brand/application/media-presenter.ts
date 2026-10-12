import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE,
  type StoragePort,
} from '../../../shared/application/ports/storage.port.js';
import type { MediaAsset } from '../domain/media-asset.js';

export interface MediaAssetView {
  id: string;
  kind: MediaAsset['kind'];
  status: MediaAsset['status'];
  contentType: string;
  /** Short-lived signed URL; present only once the asset is ready. */
  url: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  renderGroupId: string | null;
  contentItemId: string | null;
  position: number;
  errorMessage: string | null;
  createdAt: Date;
}

const VIEW_URL_TTL_SECONDS = 15 * 60;

@Injectable()
export class MediaPresenter {
  constructor(@Inject(STORAGE) private readonly storage: StoragePort) {}

  async toView(asset: MediaAsset): Promise<MediaAssetView> {
    return {
      id: asset.id,
      kind: asset.kind,
      status: asset.status,
      contentType: asset.contentType,
      url:
        asset.status === 'READY'
          ? await this.storage.createDownloadUrl(
              asset.objectKey,
              VIEW_URL_TTL_SECONDS,
            )
          : null,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      renderGroupId: asset.renderGroupId,
      contentItemId: asset.contentItemId,
      position: asset.position,
      errorMessage: asset.errorMessage,
      createdAt: asset.createdAt,
    };
  }

  toViews(assets: MediaAsset[]): Promise<MediaAssetView[]> {
    return Promise.all(assets.map((asset) => this.toView(asset)));
  }
}
