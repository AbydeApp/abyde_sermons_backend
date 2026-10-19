import { Inject, Injectable } from '@nestjs/common';
import { CHURCH_DIRECTORY, type ChurchDirectoryPort } from '../../shared/application/auth-context.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { type PresignedUpload, STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import {
  BRAND_PROFILE_REPOSITORY, type BrandProfileRepositoryPort, MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort,
} from './brand.repository.js';
import {
  applyBrandPatch, ASSET_LIST_LIMIT, ASSET_URL_TTL_SECONDS, BRAND_LOGO_MAX_BYTES, brandAssetKey, brandLockKey,
  type BrandProfile, type BrandProfilePatch, type BrandProfileView, type BrandSnapshot, defaultBrandProfile,
  type MediaAsset, PRESIGN_TTL_SECONDS, toBrandAssetView, toBrandProfileView, uploadIncomplete, uploadNotFound,
  uploadTooLarge, uploadTypeMismatch, validateLogoUpload,
} from './helper.js';

export interface PresignedBrandAsset extends PresignedUpload {
  assetId: string;
}

/** The church's brand profile and logo uploads. The renderers and Reels read the brand through it too. */
@Injectable()
export class BrandService {
  constructor(
    @Inject(BRAND_PROFILE_REPOSITORY) private readonly profiles: BrandProfileRepositoryPort,
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly assets: MediaAssetRepositoryPort,
    @Inject(CHURCH_DIRECTORY) private readonly churches: ChurchDirectoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  // ───────────── Studio ─────────────

  async get(churchId: string): Promise<BrandProfileView> {
    return this.toView(await this.load(churchId));
  }

  async update(churchId: string, patch: BrandProfilePatch): Promise<BrandProfileView> {
    // Storage is checked before the transaction opens (no network calls while holding a lock).
    const confirmed = new Map<string, MediaAsset>();
    for (const field of ['logoAssetId', 'alternateLogoAssetId'] as const) {
      const assetId = patch[field];
      if (assetId) confirmed.set(assetId, await this.confirmUpload(churchId, assetId, field));
    }
    const saved = await this.uow.runLocked(brandLockKey(churchId), async () => {
      const next = applyBrandPatch(await this.load(churchId), patch);
      for (const asset of confirmed.values()) {
        if (asset.status === 'PENDING')
          await this.assets.markReady(churchId, asset.id, {
            sizeBytes: asset.sizeBytes ?? 0,
            width: null,
            height: null,
            durationMs: null,
          });
      }
      await this.profiles.save(next);
      return next;
    });
    return this.toView(saved);
  }

  async presignAsset(input: {
    churchId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<PresignedBrandAsset> {
    const validated = validateLogoUpload(input);
    const id = newId();
    const objectKey = brandAssetKey(input.churchId, id, validated.extension);
    const presigned = await this.storage.createUploadUrl({
      key: objectKey,
      contentType: validated.contentType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: PRESIGN_TTL_SECONDS,
    });
    const now = this.clock.now();
    await this.assets.createMany([
      {
        id,
        churchId: input.churchId,
        sermonId: null,
        contentItemId: null,
        kind: 'BRAND_LOGO',
        status: 'PENDING',
        objectKey,
        contentType: validated.contentType,
        sizeBytes: input.sizeBytes,
        width: null,
        height: null,
        durationMs: null,
        renderGroupId: null,
        position: 0,
        renderSpec: null,
        metadata: { fileName: input.fileName.slice(0, 255) },
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    return { ...presigned, assetId: id };
  }

  /** Idempotent: deleting an asset that is already gone succeeds. */
  async removeAsset(churchId: string, assetId: string): Promise<void> {
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset) return;
    if (asset.kind !== 'BRAND_LOGO') throw notFound('Brand asset');
    await this.uow.runLocked(brandLockKey(churchId), async () => {
      const profile = await this.profiles.find(churchId);
      if (profile && (profile.logoAssetId === assetId || profile.alternateLogoAssetId === assetId)) {
        await this.profiles.save({
          ...profile,
          logoAssetId: profile.logoAssetId === assetId ? undefined : profile.logoAssetId,
          alternateLogoAssetId:
            profile.alternateLogoAssetId === assetId ? undefined : profile.alternateLogoAssetId,
        });
      }
      await this.assets.delete(churchId, assetId);
    });
    // The record is gone first, so the key can no longer be referenced when the object goes.
    await this.storage.deleteObject(asset.objectKey);
  }

  // ───────────── Read by the renderers and Reels ─────────────

  /** Loads the church's brand profile, or the unsaved default seeded from the church record. */
  async load(churchId: string): Promise<BrandProfile> {
    const saved = await this.profiles.find(churchId);
    if (saved) return saved;
    const church = await this.churches.findViewById(churchId);
    if (!church) throw notFound('Church');
    return defaultBrandProfile({
      id: newId(),
      churchId,
      churchName: church.name,
      primaryColor: church.primaryColor,
      secondaryColor: church.secondaryColor,
      bibleTranslation: church.preferredBibleTranslation,
      website: church.website,
    });
  }

  /** The brand as the renderer sees it; the logo is included only when the watermark is on. */
  async snapshot(profile: BrandProfile): Promise<BrandSnapshot> {
    const logo =
      profile.watermarkEnabled && profile.logoAssetId
        ? await this.assets.findById(profile.churchId, profile.logoAssetId)
        : null;
    return {
      churchName: profile.churchName,
      primaryColor: profile.primaryColor,
      secondaryColor: profile.secondaryColor,
      accentColor: profile.accentColor,
      headingFont: profile.headingFont,
      bodyFont: profile.bodyFont,
      socialHandle: profile.socialHandle,
      website: profile.website,
      logoObjectKey: logo?.status === 'READY' ? logo.objectKey : undefined,
      watermarkPosition: profile.watermarkPosition ?? 'bottom-right',
    };
  }

  // ───────────── Internals ─────────────

  private async toView(profile: BrandProfile): Promise<BrandProfileView> {
    const logos = await this.assets.listBrandLogos(profile.churchId, ASSET_LIST_LIMIT);
    const views = await Promise.all(
      logos.map(async (logo) =>
        toBrandAssetView(logo, await this.storage.createDownloadUrl(logo.objectKey, ASSET_URL_TTL_SECONDS)),
      ),
    );
    return toBrandProfileView(profile, views);
  }

  /** The asset must be this church's logo upload and the object must really be in storage. */
  private async confirmUpload(churchId: string, assetId: string, field: string): Promise<MediaAsset> {
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset || asset.kind !== 'BRAND_LOGO' || asset.status === 'FAILED') throw uploadNotFound(field);
    if (asset.status === 'READY') return asset;
    const stored = await this.storage.headObject(asset.objectKey);
    if (!stored) throw uploadIncomplete(field);
    if (stored.sizeBytes > BRAND_LOGO_MAX_BYTES) throw uploadTooLarge(field);
    if (stored.contentType && stored.contentType.split(';')[0] !== asset.contentType)
      throw uploadTypeMismatch(field);
    return { ...asset, sizeBytes: stored.sizeBytes };
  }
}
