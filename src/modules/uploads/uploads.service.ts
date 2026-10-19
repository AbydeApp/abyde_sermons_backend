import { Inject, Injectable, Logger } from '@nestjs/common';
import { checkpoint, type RunGuard } from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { type PresignedUpload, STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { newId } from '../../shared/domain/id.js';
import { UPLOAD_REPOSITORY, type UploadRepositoryPort } from './uploads.repository.js';
import {
  isKeyOwnedBy, maxBytesFor, type MediaKind, mediaKindOf, objectKeyFor, PRESIGN_TTL_SECONDS, STALE_UPLOAD_BATCH,
  STALE_UPLOAD_MS, uploadAlreadyUsed, uploadIncomplete, uploadNotFound, uploadTooLarge, uploadTypeMismatch,
  type UploadPurpose, validateUploadRequest,
} from './helper.js';

export interface PresignUploadInput {
  churchId: string;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
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

/** Presigned browser uploads: issue the URL, then verify and claim the object the browser reports. */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: UploadRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async presign(input: PresignUploadInput): Promise<PresignedUpload> {
    const validated = validateUploadRequest(input);
    const id = newId();
    const objectKey = objectKeyFor(input.churchId, input.purpose, id, validated.extension);
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

  /** Verify + claim in one step, for callers that are not inside a transaction. */
  async consume(input: { churchId: string; objectKey: string; purpose: UploadPurpose }): Promise<ConsumedUpload> {
    const verified = await this.verify(input);
    await this.claim(verified);
    return verified;
  }

  /**
   * Verifies an object key returned by the browser: it must have been issued to this church for this
   * purpose, not used before, and actually present in storage within the size limit. Never trusts
   * the key itself. Has no side effects on the upload record, so callers run it before opening a
   * transaction.
   */
  async verify(input: { churchId: string; objectKey: string; purpose: UploadPurpose }): Promise<VerifiedUpload> {
    if (!isKeyOwnedBy(input.objectKey, input.churchId)) throw uploadNotFound();
    const record = await this.uploads.findByKey(input.churchId, input.objectKey);
    if (!record || record.purpose !== input.purpose) throw uploadNotFound();
    if (record.consumedAt) throw uploadAlreadyUsed();
    const stored = await this.storage.headObject(record.objectKey);
    if (!stored) throw uploadIncomplete();
    if (stored.sizeBytes > maxBytesFor(record.purpose, record.contentType)) {
      await this.storage
        .deleteObject(record.objectKey)
        .catch((error: unknown) => this.logger.warn({ err: error }, 'Failed to delete oversize upload'));
      throw uploadTooLarge();
    }
    if (stored.contentType && stored.contentType.split(';')[0] !== record.contentType) throw uploadTypeMismatch();
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
    if (!(await this.uploads.markConsumed(upload.uploadId, this.clock.now()))) throw uploadAlreadyUsed();
  }

  /** Maintenance: removes presigned uploads that were never attached to anything (and their objects). */
  async purgeStale(guard?: RunGuard): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - STALE_UPLOAD_MS);
    const stale = await this.uploads.findStaleUnconsumed(cutoff, STALE_UPLOAD_BATCH);
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
