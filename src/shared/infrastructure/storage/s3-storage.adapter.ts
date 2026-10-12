import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type CreateUploadUrlInput,
  isPubliclyDeliverable,
  type PresignedUpload,
  type PutObjectInput,
  type StoragePort,
  type StoredObjectInfo,
} from '../../application/ports/storage.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';

/** S3-compatible adapter (AWS S3, Cloudflare R2, RustFS). Buckets stay private; access is via short-lived URLs. */
@Injectable()
export class S3StorageAdapter implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.STORAGE_BUCKET;
    this.publicBaseUrl = config.STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, '');
    this.client = new S3Client({
      region: config.STORAGE_REGION,
      endpoint: config.STORAGE_ENDPOINT,
      forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.STORAGE_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY ?? '',
      },
      // One attempt: background jobs are retried by the queue and interactive requests by the
      // client, so the SDK must not add a second retry layer.
      maxAttempts: 1,
      // connectionTimeout: time to establish the socket; requestTimeout: max socket inactivity
      // (a large download keeps data flowing, so it is not cut off).
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    });
    // Content-Type and Content-Length are part of the signature: the URL cannot be used to
    // upload a different type or a larger file than the one that was validated.
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      objectKey: input.key,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  createDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }

  async createDeliveryUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (this.publicBaseUrl && isPubliclyDeliverable(key)) {
      const path = key.split('/').map(encodeURIComponent).join('/');
      return `${this.publicBaseUrl}/${path}`;
    }
    return this.createDownloadUrl(key, expiresInSeconds);
  }

  async putObject(input: PutObjectInput): Promise<StoredObjectInfo> {
    if ((input.body === undefined) === (input.filePath === undefined))
      throw new Error('putObject needs exactly one of body or filePath');
    const sizeBytes =
      input.body?.length ?? (await stat(input.filePath ?? '')).size;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: sizeBytes,
        // A file is streamed from disk; rendered video never sits in process memory.
        Body: input.body ?? createReadStream(input.filePath ?? ''),
      }),
      { abortSignal: input.signal },
    );
    return { sizeBytes, contentType: input.contentType };
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async downloadToFile(
    key: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal },
    );
    if (!(object.Body instanceof Readable))
      throw new Error(`Object ${key} has no readable body`);
    // The signal also tears down the stream mid-download (job time limit or forced shutdown).
    await pipeline(object.Body, createWriteStream(destinationPath), { signal });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
