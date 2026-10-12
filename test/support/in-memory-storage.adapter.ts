import { readFile, writeFile } from 'node:fs/promises';
import type {
  CreateUploadUrlInput,
  PresignedUpload,
  PutObjectInput,
  StoragePort,
  StoredObjectInfo,
} from '../../src/shared/application/ports/storage.port.js';

/** Test double: "uploads" are simulated with `put()`. */
export class InMemoryStorageAdapter implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    return {
      uploadUrl: `memory://upload/${encodeURIComponent(input.key)}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      objectKey: input.key,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  put(key: string, body: Buffer | string, contentType: string): void {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async createDownloadUrl(key: string): Promise<string> {
    return `memory://download/${encodeURIComponent(key)}`;
  }

  async createDeliveryUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return `memory://delivery/${encodeURIComponent(key)}?ttl=${expiresInSeconds}`;
  }

  async putObject(input: PutObjectInput): Promise<StoredObjectInfo> {
    input.signal?.throwIfAborted();
    const body = input.body ?? (await readFile(input.filePath ?? ''));
    this.put(input.key, body, input.contentType);
    return { sizeBytes: body.length, contentType: input.contentType };
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    const object = this.objects.get(key);
    return object
      ? { sizeBytes: object.body.length, contentType: object.contentType }
      : null;
  }

  async downloadToFile(
    key: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const object = this.objects.get(key);
    if (!object) throw new Error(`Object ${key} not found`);
    await writeFile(destinationPath, object.body);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
