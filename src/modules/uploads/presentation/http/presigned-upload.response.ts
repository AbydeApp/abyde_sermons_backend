import type { PresignedUpload } from '../../../../shared/application/ports/storage.port.js';

export interface PresignedUploadResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

export const toPresignedUploadResponse = (
  upload: PresignedUpload,
): PresignedUploadResponse => ({
  uploadUrl: upload.uploadUrl,
  method: upload.method,
  headers: upload.headers,
  objectKey: upload.objectKey,
  expiresAt: upload.expiresAt.toISOString(),
});
