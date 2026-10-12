import type { BrandProfile, BrandSnapshot } from '../../../domain/brand-profile.js';
import type { CaptionCue } from '../../../domain/captions.js';
import type { MediaAsset, MediaTechnicalMetadata } from '../../../domain/media-asset.js';
import type { CardSpec } from '../../../domain/template-svg.js';

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

export const BRAND_RENDERER = Symbol('BRAND_RENDERER');

/** A file the renderer wrote into the caller's work directory, with its technical metadata. */
export interface RenderedMedia {
  filePath: string;
  contentType: string;
  width: number;
  height: number;
  durationMs?: number;
}

interface RenderContext {
  /** Scratch directory owned by the caller; the renderer only writes inside it. */
  workDir: string;
  /** Output file name (without directory or extension). */
  name: string;
  /** Aborts the render (job time limit or shutdown). */
  signal?: AbortSignal;
}

export interface RenderImageInput extends RenderContext {
  card: CardSpec;
  /** Local path of the logo to stamp, when the brand has one. */
  logoPath?: string;
}

export interface RenderCarouselInput extends Omit<RenderImageInput, 'card'> {
  cards: CardSpec[];
}

export interface RenderVideoInput extends RenderContext {
  /** Local path of the source sermon video. */
  sourcePath: string;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  captions: CaptionCue[];
  brand: BrandSnapshot;
  logoPath?: string;
}

export interface RenderThumbnailInput extends RenderContext {
  videoPath: string;
  atMs: number;
}

/**
 * Deterministic media rendering (templates, not generative models). The renderer works on local
 * files only; storing the result and recording the asset is the use case's job.
 */
export interface BrandRenderingPort {
  renderImage(input: RenderImageInput): Promise<RenderedMedia>;
  renderCarousel(input: RenderCarouselInput): Promise<RenderedMedia[]>;
  renderVideo(input: RenderVideoInput): Promise<RenderedMedia>;
  renderThumbnail(input: RenderThumbnailInput): Promise<RenderedMedia>;
}

export const MEDIA_SETTINGS = Symbol('MEDIA_SETTINGS');

export interface MediaSettings {
  maxClipSeconds: number;
}

export const MEDIA_OBSERVER = Symbol('MEDIA_OBSERVER');

/** Render metrics hook, implemented by the observability layer. */
export interface MediaObserverPort {
  rendered(kind: string, durationMs: number, ok: boolean): void;
}
