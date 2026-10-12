import { validationError } from '../../../shared/domain/domain-error.js';

export const MEDIA_ASSET_KINDS = [
  'BRAND_LOGO',
  'IMAGE',
  'CAROUSEL_SLIDE',
  'VIDEO',
  'THUMBNAIL',
] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];
export type MediaAssetStatus = 'PENDING' | 'READY' | 'FAILED';

export interface MediaAsset {
  id: string;
  churchId: string;
  sermonId: string | null;
  contentItemId: string | null;
  kind: MediaAssetKind;
  status: MediaAssetStatus;
  objectKey: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Assets produced by one render request share a group. */
  renderGroupId: string | null;
  position: number;
  /** What the worker renders; null for uploaded assets. */
  renderSpec: unknown;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaTechnicalMetadata {
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

const MB = 1024 ** 2;
export const BRAND_LOGO_MAX_BYTES = 5 * MB;

/** Raster formats only: SVG logos could carry script and are never accepted. */
const LOGO_TYPES: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
};

export function validateLogoUpload(input: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): { contentType: string; extension: string } {
  const contentType =
    input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const extensions = LOGO_TYPES[contentType];
  if (!extensions)
    throw validationError('contentType', 'Upload a PNG, JPEG or WebP image');
  const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
  if (!extensions.includes(extension))
    throw validationError(
      'fileName',
      'The file extension does not match its type',
    );
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0)
    throw validationError('sizeBytes', 'File size is required');
  if (input.sizeBytes > BRAND_LOGO_MAX_BYTES)
    throw validationError('sizeBytes', 'File is too large (max 5 MB)');
  return { contentType, extension };
}

/** `churches/{churchId}/brand/{assetId}.{ext}` */
export const brandAssetKey = (
  churchId: string,
  assetId: string,
  extension: string,
): string => `churches/${churchId}/brand/${assetId}.${extension}`;

const GENERATED_FOLDERS: Record<
  Exclude<MediaAssetKind, 'BRAND_LOGO'>,
  string
> = {
  IMAGE: 'images',
  CAROUSEL_SLIDE: 'carousels',
  VIDEO: 'reels',
  THUMBNAIL: 'thumbnails',
};

/** `churches/{churchId}/sermons/{sermonId}/generated/{folder}/{assetId}.{ext}` */
export const generatedAssetKey = (
  churchId: string,
  sermonId: string,
  kind: Exclude<MediaAssetKind, 'BRAND_LOGO'>,
  assetId: string,
  extension: string,
): string =>
  `churches/${churchId}/sermons/${sermonId}/generated/${GENERATED_FOLDERS[kind]}/${assetId}.${extension}`;
