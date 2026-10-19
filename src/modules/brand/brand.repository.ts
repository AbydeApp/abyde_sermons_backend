import { Inject, Injectable } from '@nestjs/common';
import type {
  BrandProfile as BrandProfileRow,
  MediaAsset as MediaAssetRow,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import {
  type BrandProfile,
  type BrandVoice,
  defaultBrandVoice,
  type MediaAsset,
  type MediaTechnicalMetadata,
  type WatermarkPosition,
} from './helper.js';

export const BRAND_PROFILE_REPOSITORY = Symbol('BRAND_PROFILE_REPOSITORY');

export interface BrandProfileRepositoryPort {
  find(churchId: string): Promise<BrandProfile | null>;
  /** Upserts the single profile of the church. */
  save(profile: BrandProfile): Promise<void>;
}

export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

export interface MediaAssetRepositoryPort {
  createMany(assets: MediaAsset[]): Promise<void>;
  findById(churchId: string, id: string): Promise<MediaAsset | null>;
  findByIds(churchId: string, ids: string[]): Promise<MediaAsset[]>;
  /** The church's uploaded logos (pending or ready), newest first, bounded. */
  listBrandLogos(churchId: string, limit: number): Promise<MediaAsset[]>;
  /** Assets of several content items, newest first, bounded. */
  listByContentIds(
    churchId: string,
    contentItemIds: string[],
    limit: number,
  ): Promise<MediaAsset[]>;
  /** Newest first, bounded. */
  listByContent(
    churchId: string,
    contentItemId: string,
    limit: number,
  ): Promise<MediaAsset[]>;
  /** In slide order. */
  listByRenderGroup(
    churchId: string,
    renderGroupId: string,
  ): Promise<MediaAsset[]>;
  /** PENDING → READY. False when the asset is gone or no longer pending. */
  markReady(
    churchId: string,
    id: string,
    technical: MediaTechnicalMetadata,
  ): Promise<boolean>;
  /** PENDING → FAILED for the given assets. */
  markFailed(churchId: string, ids: string[], message: string): Promise<void>;
  delete(churchId: string, id: string): Promise<void>;
  /** Maintenance only (all churches): fails renders with no progress since `olderThan`. */
  failStaleRenders(olderThan: Date, message: string): Promise<number>;
  /** Maintenance only (all churches): logo uploads that were never attached to a profile. */
  findStaleUploads(olderThan: Date, limit: number): Promise<MediaAsset[]>;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

const toProfile = (row: BrandProfileRow): BrandProfile => ({
  id: row.id,
  churchId: row.churchId,
  churchName: row.churchName,
  logoAssetId: row.logoAssetId ?? undefined,
  alternateLogoAssetId: row.alternateLogoAssetId ?? undefined,
  primaryColor: row.primaryColor,
  secondaryColor: row.secondaryColor,
  accentColor: row.accentColor,
  headingFont: row.headingFont,
  bodyFont: row.bodyFont,
  socialHandle: row.socialHandle ?? undefined,
  website: row.website ?? undefined,
  footerText: row.footerText ?? undefined,
  watermarkEnabled: row.watermarkEnabled,
  watermarkPosition:
    (row.watermarkPosition as WatermarkPosition | null) ?? undefined,
  voice: { ...defaultBrandVoice(), ...(row.voice as Partial<BrandVoice>) },
  templateDefaults: row.templateDefaults as BrandProfile['templateDefaults'],
});

@Injectable()
export class PrismaBrandProfileRepository implements BrandProfileRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async find(churchId: string): Promise<BrandProfile | null> {
    const row = await this.prisma.db.brandProfile.findUnique({
      where: { churchId },
    });
    return row ? toProfile(row) : null;
  }

  async save(profile: BrandProfile): Promise<void> {
    const data = {
      churchName: profile.churchName,
      logoAssetId: profile.logoAssetId ?? null,
      alternateLogoAssetId: profile.alternateLogoAssetId ?? null,
      primaryColor: profile.primaryColor,
      secondaryColor: profile.secondaryColor,
      accentColor: profile.accentColor,
      headingFont: profile.headingFont,
      bodyFont: profile.bodyFont,
      socialHandle: profile.socialHandle ?? null,
      website: profile.website ?? null,
      footerText: profile.footerText ?? null,
      watermarkEnabled: profile.watermarkEnabled,
      watermarkPosition: profile.watermarkPosition ?? null,
      voice: json(profile.voice),
      templateDefaults: json(profile.templateDefaults),
    };
    await this.prisma.db.brandProfile.upsert({
      where: { churchId: profile.churchId },
      create: { id: profile.id, churchId: profile.churchId, ...data },
      update: data,
    });
  }
}

const toAsset = (row: MediaAssetRow): MediaAsset => ({
  ...row,
  sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  renderSpec: row.renderSpec,
  metadata: row.metadata as Record<string, unknown>,
});

@Injectable()
export class PrismaMediaAssetRepository implements MediaAssetRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createMany(assets: MediaAsset[]): Promise<void> {
    await this.prisma.db.mediaAsset.createMany({
      data: assets.map(({ createdAt: _c, updatedAt: _u, ...asset }) => ({
        ...asset,
        sizeBytes: asset.sizeBytes === null ? null : BigInt(asset.sizeBytes),
        renderSpec:
          asset.renderSpec === null ? undefined : json(asset.renderSpec),
        metadata: json(asset.metadata),
      })),
    });
  }

  async findById(churchId: string, id: string): Promise<MediaAsset | null> {
    const row = await this.prisma.db.mediaAsset.findFirst({
      where: { id, churchId },
    });
    return row ? toAsset(row) : null;
  }

  async findByIds(churchId: string, ids: string[]): Promise<MediaAsset[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: { churchId, id: { in: ids } },
    });
    return rows.map(toAsset);
  }

  async listBrandLogos(churchId: string, limit: number): Promise<MediaAsset[]> {
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: { churchId, kind: 'BRAND_LOGO', status: { not: 'FAILED' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toAsset);
  }

  async listByContentIds(
    churchId: string,
    contentItemIds: string[],
    limit: number,
  ): Promise<MediaAsset[]> {
    if (contentItemIds.length === 0) return [];
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: { churchId, contentItemId: { in: contentItemIds } },
      orderBy: [{ createdAt: 'desc' }, { position: 'asc' }],
      take: limit,
    });
    return rows.map(toAsset);
  }

  async listByContent(
    churchId: string,
    contentItemId: string,
    limit: number,
  ): Promise<MediaAsset[]> {
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: { churchId, contentItemId },
      orderBy: [{ createdAt: 'desc' }, { position: 'asc' }],
      take: limit,
    });
    return rows.map(toAsset);
  }

  async listByRenderGroup(
    churchId: string,
    renderGroupId: string,
  ): Promise<MediaAsset[]> {
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: { churchId, renderGroupId },
      orderBy: { position: 'asc' },
    });
    return rows.map(toAsset);
  }

  async markReady(
    churchId: string,
    id: string,
    technical: MediaTechnicalMetadata,
  ): Promise<boolean> {
    const result = await this.prisma.db.mediaAsset.updateMany({
      where: { id, churchId, status: 'PENDING' },
      data: {
        status: 'READY',
        sizeBytes: BigInt(technical.sizeBytes),
        width: technical.width,
        height: technical.height,
        durationMs: technical.durationMs,
        errorMessage: null,
      },
    });
    return result.count === 1;
  }

  async markFailed(
    churchId: string,
    ids: string[],
    message: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.db.mediaAsset.updateMany({
      where: { churchId, id: { in: ids }, status: 'PENDING' },
      data: { status: 'FAILED', errorMessage: message.slice(0, 500) },
    });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.mediaAsset.deleteMany({ where: { id, churchId } });
  }

  async failStaleRenders(olderThan: Date, message: string): Promise<number> {
    const result = await this.prisma.db.mediaAsset.updateMany({
      where: {
        status: 'PENDING',
        kind: { not: 'BRAND_LOGO' },
        updatedAt: { lt: olderThan },
      },
      data: { status: 'FAILED', errorMessage: message },
    });
    return result.count;
  }

  async findStaleUploads(
    olderThan: Date,
    limit: number,
  ): Promise<MediaAsset[]> {
    const rows = await this.prisma.db.mediaAsset.findMany({
      where: {
        status: 'PENDING',
        kind: 'BRAND_LOGO',
        createdAt: { lt: olderThan },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toAsset);
  }
}
