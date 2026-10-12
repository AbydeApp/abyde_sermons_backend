import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  checkpoint,
  type RunGuard,
} from '../../../../shared/application/jobs.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  STORAGE,
  type PresignedUpload,
  type StoragePort,
} from '../../../../shared/application/ports/storage.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import {
  isKeyOwnedBy,
  maxBytesFor,
  mediaKindOf,
  type MediaKind,
  objectKeyFor,
  type UploadPurpose,
  validateUploadRequest,
} from '../../domain/upload-policy.js';
import {
  UPLOAD_REPOSITORY,
  type UploadRepositoryPort,
} from '../ports/out/upload-repository.port.js';

const PRESIGN_TTL_SECONDS = 15 * 60;

export interface PresignUploadInput {
  churchId: string;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

@Injectable()
export class PresignUploadUseCase {
  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: UploadRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: PresignUploadInput): Promise<PresignedUpload> {
    const validated = validateUploadRequest(input);
    const id = newId();
    const objectKey = objectKeyFor(
      input.churchId,
      input.purpose,
      id,
      validated.extension,
    );
    const presigned = await this.storage.createUploadUrl({
      key: objectKey,
      contentType: validated.contentType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: PRESIGN_TTL_SECONDS,
    });
    await this.uploads.create({
      id,
      churchId: input.churchId,
      objectKey,
      purpose: input.purpose,
      fileName: input.fileName.slice(0, 255),
      contentType: validated.contentType,
      sizeBytes: input.sizeBytes,
      expiresAt: presigned.expiresAt,
      consumedAt: null,
      createdAt: this.clock.now(),
    });
    return presigned;
  }
}

export interface ConsumedUpload {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  kind: MediaKind;
  fileName: string;
}

export interface VerifiedUpload extends ConsumedUpload {
  uploadId: string;
}

const uploadError = (code: string, message: string) =>
  new DomainError('UNPROCESSABLE', code, message, { objectKey: [message] });

/**
 * Verifies an object key returned by the browser: it must have been issued to this church for this purpose,
 * not used before, and actually present in storage within the size limit. Never trusts the key itself.
 */
@Injectable()
export class ConsumeUploadUseCase {
  private readonly logger = new Logger(ConsumeUploadUseCase.name);

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: UploadRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Verify + claim in one step, for callers that are not inside a transaction. */
  async execute(input: {
    churchId: string;
    objectKey: string;
    purpose: UploadPurpose;
  }): Promise<ConsumedUpload> {
    const verified = await this.verify(input);
    await this.claim(verified);
    return verified;
  }

  /**
   * Checks ownership, purpose and the stored object (network call to storage). Has no side effects
   * on the upload record, so callers run it before opening a transaction.
   */
  async verify(input: {
    churchId: string;
    objectKey: string;
    purpose: UploadPurpose;
  }): Promise<VerifiedUpload> {
    if (!isKeyOwnedBy(input.objectKey, input.churchId))
      throw uploadError('UPLOAD_NOT_FOUND', 'Upload not found');
    const record = await this.uploads.findByKey(
      input.churchId,
      input.objectKey,
    );
    if (!record || record.purpose !== input.purpose)
      throw uploadError('UPLOAD_NOT_FOUND', 'Upload not found');
    if (record.consumedAt)
      throw uploadError(
        'UPLOAD_ALREADY_USED',
        'This upload has already been used',
      );
    const stored = await this.storage.headObject(record.objectKey);
    if (!stored)
      throw uploadError(
        'UPLOAD_INCOMPLETE',
        'The file has not finished uploading',
      );
    if (stored.sizeBytes > maxBytesFor(record.purpose, record.contentType)) {
      await this.storage
        .deleteObject(record.objectKey)
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'Failed to delete oversize upload'),
        );
      throw uploadError('UPLOAD_TOO_LARGE', 'The uploaded file is too large');
    }
    if (
      stored.contentType &&
      stored.contentType.split(';')[0] !== record.contentType
    ) {
      throw uploadError(
        'UPLOAD_TYPE_MISMATCH',
        'The uploaded file type does not match',
      );
    }
    return {
      uploadId: record.id,
      objectKey: record.objectKey,
      contentType: record.contentType,
      sizeBytes: stored.sizeBytes,
      kind: mediaKindOf(record.purpose, record.contentType),
      fileName: record.fileName,
    };
  }

  /** Marks the upload used, exactly once. Joins the caller's transaction, so a rollback releases it. */
  async claim(upload: VerifiedUpload): Promise<void> {
    if (!(await this.uploads.markConsumed(upload.uploadId, this.clock.now()))) {
      throw uploadError(
        'UPLOAD_ALREADY_USED',
        'This upload has already been used',
      );
    }
  }
}

/** Maintenance: removes presigned uploads that were never attached to anything (and their objects). */
@Injectable()
export class PurgeStaleUploadsUseCase {
  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: UploadRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 24 * 3600 * 1000);
    const stale = await this.uploads.findStaleUnconsumed(cutoff, 500);
    let purged = 0;
    for (const upload of stale) {
      await checkpoint(guard);
      // Remove the record first: once it is gone the key can no longer be attached to a sermon,
      // so deleting the object cannot race with a concurrent upload consumption.
      if (!(await this.uploads.deleteIfUnconsumed(upload.id))) continue;
      await this.storage.deleteObject(upload.objectKey);
      purged++;
    }
    return purged;
  }
}
