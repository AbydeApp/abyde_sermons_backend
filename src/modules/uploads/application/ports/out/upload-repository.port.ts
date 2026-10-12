import type { UploadPurpose } from '../../../domain/upload-policy.js';

export const UPLOAD_REPOSITORY = Symbol('UPLOAD_REPOSITORY');

export interface UploadRecord {
  id: string;
  churchId: string;
  objectKey: string;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface UploadRepositoryPort {
  create(record: UploadRecord): Promise<void>;
  findByKey(churchId: string, objectKey: string): Promise<UploadRecord | null>;
  /** Marks consumed only if unconsumed; false when another request already used the upload. */
  markConsumed(id: string, at: Date): Promise<boolean>;
  findStaleUnconsumed(olderThan: Date, limit: number): Promise<UploadRecord[]>;
  /** Deletes the record only if it is still unconsumed; false when it was consumed meanwhile. */
  deleteIfUnconsumed(id: string): Promise<boolean>;
}
