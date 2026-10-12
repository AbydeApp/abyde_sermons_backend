import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort,} from '../../../../shared/application/ports/clock.port.js';
import { type PresignedUpload, STORAGE, type StoragePort } from '../../../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../../shared/application/ports/unit-of-work.port.js';
import { notFound, validationError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { CHURCH_REPOSITORY, type ChurchRepositoryPort } from '../../../church/application/ports/out/church-repository.port.js';
import type { ContentType } from '../../../content/domain/content-types.js';
import {  applyBrandPatch, type BrandProfile, type BrandProfilePatch, type BrandSnapshot, defaultBrandProfile} from '../../domain/brand-profile.js';
import { BRAND_LOGO_MAX_BYTES, brandAssetKey, type MediaAsset, validateLogoUpload } from '../../domain/media-asset.js';
import { ASPECTS, type Aspect, findTemplate, resolveTemplate,TEMPLATES, type TemplateDefinition } from '../../domain/templates.js';
import { type Box, logoBox, MAX_CARD_CHARS, renderCardSvg } from '../../domain/template-svg.js';
import { BRAND_PROFILE_REPOSITORY, type BrandProfileRepositoryPort, MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../ports/out/brand.ports.js';

const PRESIGN_TTL_SECONDS = 15 * 60;
const LOGO_URL_TTL_SECONDS = 15 * 60;
const lockKey = (churchId: string) => `brand-profile:${churchId}`;

export interface BrandLogoView {
  assetId: string;
  url: string;
}

export interface BrandProfileView extends Omit<
  BrandProfile,
  'id' | 'churchId' | 'logoAssetId' | 'alternateLogoAssetId'
> {
  logo: BrandLogoView | null;
  alternateLogo: BrandLogoView | null;
}

/** Loads the church's brand profile, or the unsaved default seeded from the church record. */
@Injectable()
export class BrandProfileService {
  constructor(
    @Inject(BRAND_PROFILE_REPOSITORY)
    private readonly profiles: BrandProfileRepositoryPort,
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async load(churchId: string): Promise<BrandProfile> {
    const saved = await this.profiles.find(churchId);
    if (saved) return saved;
    const church = (await this.churches.findById(churchId))?.snapshot();
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

  /**
   * The brand as the Reel renderer sees it: the logo follows `videoSettings.logoPosition`
   * (independent of the image watermark switch).
   */
  async reelSnapshot(profile: BrandProfile): Promise<BrandSnapshot> {
    const { logoPosition } = profile.videoSettings;
    const logo =
      logoPosition !== 'none' && profile.logoAssetId
        ? await this.assets.findById(profile.churchId, profile.logoAssetId)
        : null;
    return {
      ...(await this.snapshot({ ...profile, watermarkEnabled: false })),
      logoObjectKey: logo?.status === 'READY' ? logo.objectKey : undefined,
      watermarkPosition:
        logoPosition === 'none'
          ? (profile.watermarkPosition ?? 'bottom-right')
          : logoPosition,
    };
  }

  async toView(profile: BrandProfile): Promise<BrandProfileView> {
    const {
      id: _id,
      churchId,
      logoAssetId,
      alternateLogoAssetId,
      ...rest
    } = profile;
    return {
      ...rest,
      logo: await this.logoView(churchId, logoAssetId),
      alternateLogo: await this.logoView(churchId, alternateLogoAssetId),
    };
  }

  private async logoView(
    churchId: string,
    assetId: string | undefined,
  ): Promise<BrandLogoView | null> {
    if (!assetId) return null;
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset || asset.status !== 'READY') return null;
    return {
      assetId,
      url: await this.storage.createDownloadUrl(
        asset.objectKey,
        LOGO_URL_TTL_SECONDS,
      ),
    };
  }
}

@Injectable()
export class GetBrandProfileUseCase {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
  ) {}

  async execute(churchId: string): Promise<BrandProfileView> {
    return this.brand.toView(await this.brand.load(churchId));
  }
}

@Injectable()
export class UpdateBrandProfileUseCase {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
    @Inject(BRAND_PROFILE_REPOSITORY)
    private readonly profiles: BrandProfileRepositoryPort,
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(
    churchId: string,
    patch: BrandProfilePatch,
  ): Promise<BrandProfileView> {
    // Storage is checked before the transaction opens (no network calls while holding a lock).
    const confirmed = new Map<string, MediaAsset>();
    for (const field of ['logoAssetId', 'alternateLogoAssetId'] as const) {
      const assetId = patch[field];
      if (assetId)
        confirmed.set(
          assetId,
          await this.confirmUpload(churchId, assetId, field),
        );
    }
    const saved = await this.uow.runLocked(lockKey(churchId), async () => {
      const next = applyBrandPatch(await this.brand.load(churchId), patch);
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
    return this.brand.toView(saved);
  }

  /** The asset must be this church's logo upload and the object must really be in storage. */
  private async confirmUpload(
    churchId: string,
    assetId: string,
    field: string,
  ): Promise<MediaAsset> {
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset || asset.kind !== 'BRAND_LOGO' || asset.status === 'FAILED')
      throw validationError(field, 'Upload not found');
    if (asset.status === 'READY') return asset;
    const stored = await this.storage.headObject(asset.objectKey);
    if (!stored)
      throw validationError(field, 'The file has not finished uploading');
    if (stored.sizeBytes > BRAND_LOGO_MAX_BYTES)
      throw validationError(field, 'The uploaded file is too large');
    if (
      stored.contentType &&
      stored.contentType.split(';')[0] !== asset.contentType
    )
      throw validationError(field, 'The uploaded file type does not match');
    return { ...asset, sizeBytes: stored.sizeBytes };
  }
}

export interface PresignedBrandAsset extends PresignedUpload {
  assetId: string;
}

@Injectable()
export class PresignBrandAssetUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: {
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
}

@Injectable()
export class DeleteBrandAssetUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly assets: MediaAssetRepositoryPort,
    @Inject(BRAND_PROFILE_REPOSITORY)
    private readonly profiles: BrandProfileRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  /** Idempotent: deleting an asset that is already gone succeeds. */
  async execute(churchId: string, assetId: string): Promise<void> {
    const asset = await this.assets.findById(churchId, assetId);
    if (!asset) return;
    if (asset.kind !== 'BRAND_LOGO') throw notFound('Brand asset');
    await this.uow.runLocked(lockKey(churchId), async () => {
      const profile = await this.profiles.find(churchId);
      if (
        profile &&
        (profile.logoAssetId === assetId ||
          profile.alternateLogoAssetId === assetId)
      ) {
        await this.profiles.save({
          ...profile,
          logoAssetId:
            profile.logoAssetId === assetId ? undefined : profile.logoAssetId,
          alternateLogoAssetId:
            profile.alternateLogoAssetId === assetId
              ? undefined
              : profile.alternateLogoAssetId,
        });
      }
      await this.assets.delete(churchId, assetId);
    });
    // The record is gone first, so the key can no longer be referenced when the object goes.
    await this.storage.deleteObject(asset.objectKey);
  }
}

export interface TemplateCatalogView {
  templates: readonly TemplateDefinition[];
  aspects: typeof ASPECTS;
  defaults: Partial<Record<ContentType, string>>;
}

@Injectable()
export class ListTemplatesUseCase {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
  ) {}

  async execute(churchId: string): Promise<TemplateCatalogView> {
    return {
      templates: TEMPLATES,
      aspects: ASPECTS,
      defaults: (await this.brand.load(churchId)).templateDefaults,
    };
  }
}

@Injectable()
export class SetDefaultTemplateUseCase {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
    @Inject(BRAND_PROFILE_REPOSITORY)
    private readonly profiles: BrandProfileRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(
    churchId: string,
    contentType: ContentType,
    templateId: string,
  ): Promise<{ contentType: ContentType; templateId: string }> {
    if (!findTemplate(templateId))
      throw validationError('templateId', 'Unknown template');
    await this.uow.runLocked(lockKey(churchId), async () => {
      const profile = await this.brand.load(churchId);
      await this.profiles.save({
        ...profile,
        templateDefaults: {
          ...profile.templateDefaults,
          [contentType]: templateId,
        },
      });
    });
    return { contentType, templateId };
  }
}

export interface BrandPreview {
  svg: string;
  width: number;
  height: number;
  /** Where the client overlays the logo (the SVG itself never references external files). */
  logo: (Box & { url: string }) | null;
}

/**
 * Instant preview of a card with the current (or a not-yet-saved) brand. It is the same SVG the
 * worker rasterises, so nothing expensive runs in the API process.
 */
@Injectable()
export class PreviewBrandUseCase {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async execute(
    churchId: string,
    input: {
      text: string;
      heading?: string;
      attribution?: string;
      templateId?: string;
      aspect: Aspect;
      /** Unsaved brand changes to preview. */
      brand?: BrandProfilePatch;
    },
  ): Promise<BrandPreview> {
    if (input.text.length > MAX_CARD_CHARS)
      throw validationError(
        'text',
        `Must be at most ${MAX_CARD_CHARS} characters`,
      );
    const saved = await this.brand.load(churchId);
    // Asset references are not previewable changes; only look and feel is.
    const {
      logoAssetId: _l,
      alternateLogoAssetId: _a,
      ...look
    } = input.brand ?? {};
    const profile = applyBrandPatch(saved, look);
    const template = resolveTemplate({
      format: 'image',
      contentType: 'QUOTE',
      requested: input.templateId,
      churchDefaults: profile.templateDefaults,
    });
    const snapshot = await this.brand.snapshot(profile);
    const { width, height } = ASPECTS[input.aspect];
    return {
      svg: renderCardSvg({
        template,
        width,
        height,
        heading: input.heading,
        text: input.text,
        attribution: input.attribution,
        brand: snapshot,
      }),
      width,
      height,
      logo: snapshot.logoObjectKey
        ? {
            ...logoBox(width, height, snapshot.watermarkPosition),
            url: await this.storage.createDownloadUrl(
              snapshot.logoObjectKey,
              LOGO_URL_TTL_SECONDS,
            ),
          }
        : null,
    };
  }
}
