import { z } from 'zod';
import { DomainError, validationError } from '../../shared/domain/domain-error.js';
import type { PresignedUpload } from '../../shared/application/ports/storage.port.js';

// ───────────────────────── Constants ─────────────────────────

export const PRESIGN_TTL_SECONDS = 15 * 60;
/** Presigned uploads never attached to anything are removed after this long. */
export const STALE_UPLOAD_MS = 24 * 3600 * 1000;
export const STALE_UPLOAD_BATCH = 500;

// ───────────────────────── Errors ─────────────────────────

export const uploadError = (code: string, message: string) =>
  new DomainError('UNPROCESSABLE', code, message, { objectKey: [message] });

export const uploadNotFound = () => uploadError('UPLOAD_NOT_FOUND', 'Upload not found');
export const uploadAlreadyUsed = () =>
  uploadError('UPLOAD_ALREADY_USED', 'This upload has already been used');
export const uploadIncomplete = () =>
  uploadError('UPLOAD_INCOMPLETE', 'The file has not finished uploading');
export const uploadTooLarge = () => uploadError('UPLOAD_TOO_LARGE', 'The uploaded file is too large');
export const uploadTypeMismatch = () =>
  uploadError('UPLOAD_TYPE_MISMATCH', 'The uploaded file type does not match');

// ───────────────────────── Upload policy ─────────────────────────

export type UploadPurpose = 'SERMON_MEDIA';

export type MediaKind = 'AUDIO' | 'VIDEO' | 'PDF' | 'DOCX' | 'TEXT';

interface AllowedType {
  extensions: string[];
  kind: MediaKind;
  maxBytes: number;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Allow-listed MIME types per purpose, with the extensions each may carry and a size cap. */
const POLICIES: Record<UploadPurpose, Record<string, AllowedType>> = {
  SERMON_MEDIA: {
    'audio/mpeg': { extensions: ['mp3'], kind: 'AUDIO', maxBytes: 2 * GB },
    'audio/mp3': { extensions: ['mp3'], kind: 'AUDIO', maxBytes: 2 * GB },
    'audio/wav': { extensions: ['wav'], kind: 'AUDIO', maxBytes: 2 * GB },
    'audio/x-wav': { extensions: ['wav'], kind: 'AUDIO', maxBytes: 2 * GB },
    'audio/wave': { extensions: ['wav'], kind: 'AUDIO', maxBytes: 2 * GB },
    'video/mp4': { extensions: ['mp4'], kind: 'VIDEO', maxBytes: 2 * GB },
    'application/pdf': { extensions: ['pdf'], kind: 'PDF', maxBytes: 2 * GB },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      extensions: ['docx'],
      kind: 'DOCX',
      maxBytes: 2 * GB,
    },
    'text/plain': { extensions: ['txt'], kind: 'TEXT', maxBytes: 2 * GB },
  },
};

const FOLDERS: Record<UploadPurpose, string> = {
  SERMON_MEDIA: 'sermons',
};

export interface ValidatedUpload {
  contentType: string;
  extension: string;
  kind: MediaKind;
  maxBytes: number;
}

export function validateUploadRequest(input: {
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): ValidatedUpload {
  const contentType =
    input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const allowed = POLICIES[input.purpose][contentType];
  if (!allowed)
    throw validationError('contentType', 'This file type is not supported');
  const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
  if (!allowed.extensions.includes(extension)) {
    throw validationError(
      'fileName',
      'The file extension does not match its type',
    );
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw validationError('sizeBytes', 'File size is required');
  }
  if (input.sizeBytes > allowed.maxBytes) {
    throw validationError(
      'sizeBytes',
      `File is too large (max ${Math.round(allowed.maxBytes / MB)} MB)`,
    );
  }
  return {
    contentType,
    extension,
    kind: allowed.kind,
    maxBytes: allowed.maxBytes,
  };
}

export function mediaKindOf(
  purpose: UploadPurpose,
  contentType: string,
): MediaKind {
  const allowed = POLICIES[purpose][contentType];
  if (!allowed)
    throw new DomainError(
      'UNPROCESSABLE',
      'UNSUPPORTED_MEDIA',
      'This file type is not supported.',
    );
  return allowed.kind;
}

export function maxBytesFor(
  purpose: UploadPurpose,
  contentType: string,
): number {
  return POLICIES[purpose][contentType]?.maxBytes ?? 0;
}

/** Church-scoped, unguessable storage key. */
export const objectKeyFor = (
  churchId: string,
  purpose: UploadPurpose,
  id: string,
  extension: string,
): string => `churches/${churchId}/${FOLDERS[purpose]}/${id}.${extension}`;

export const isKeyOwnedBy = (objectKey: string, churchId: string): boolean =>
  objectKey.startsWith(`churches/${churchId}/`);

// ───────────────────────── Responses & schemas ─────────────────────────

export interface PresignedUploadResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

export const toPresignedUploadResponse = (upload: PresignedUpload): PresignedUploadResponse => ({
  uploadUrl: upload.uploadUrl,
  method: upload.method,
  headers: upload.headers,
  objectKey: upload.objectKey,
  expiresAt: upload.expiresAt.toISOString(),
});

export const PresignBody = z.object({
  fileName: z.string({ error: 'File name is required' }).min(1, 'File name is required').max(255),
  contentType: z.string({ error: 'Content type is required' }).min(1).max(255),
  sizeBytes: z.number({ error: 'File size is required' }).int().positive(),
});

export const SermonPresignBody = PresignBody.extend({ purpose: z.literal('SERMON_MEDIA') });
