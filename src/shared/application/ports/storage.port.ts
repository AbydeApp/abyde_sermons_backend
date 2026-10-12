export const STORAGE = Symbol('STORAGE');

export interface CreateUploadUrlInput {
  key: string;
  contentType: string;
  /** Exact size the client declared; the signed URL only accepts a body of this length. */
  sizeBytes: number;
  expiresInSeconds: number;
}

export interface PresignedUpload {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

export interface PutObjectInput {
  key: string;
  contentType: string;
  /** Exactly one of `body` (small, already in memory) or `filePath` (streamed from disk). */
  body?: Buffer;
  filePath?: string;
  signal?: AbortSignal;
}

export interface StoragePort {
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  createDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /**
   * URL a third party (a social network ingesting media) can fetch for `expiresInSeconds`.
   * Generated media may be served from the public delivery host when one is configured; everything
   * else (source sermons included) is only ever reachable through a short-lived signed URL.
   */
  createDeliveryUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Server-side write of rendered media. Overwrites, so a retried render is idempotent. */
  putObject(input: PutObjectInput): Promise<StoredObjectInfo>;
  headObject(key: string): Promise<StoredObjectInfo | null>;
  /** Streams the object to a local file (never buffers large media in memory). */
  downloadToFile(
    key: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

/** Only generated media may leave through the public delivery host. */
export const isPubliclyDeliverable = (key: string): boolean =>
  /^churches\/[^/]+\/sermons\/[^/]+\/generated\//.test(key);
