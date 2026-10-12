import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { StoragePort } from '../../../../../shared/application/ports/storage.port.js';
import type { ScratchSpacePort } from '../../../../sermons/application/ports/out/processing.ports.js';

/**
 * For providers that take bytes rather than a URL (YouTube, X, LinkedIn): the object is streamed
 * from storage to scratch disk, then streamed to the provider. Media never sits in memory whole.
 */
export class MediaFiles {
  constructor(
    private readonly storage: StoragePort,
    private readonly scratch: ScratchSpacePort,
  ) {}

  withLocalFile<T>(
    objectKey: string,
    signal: AbortSignal | undefined,
    fn: (file: LocalMedia) => Promise<T>,
  ): Promise<T> {
    return this.scratch.withDirectory(async (dir) => {
      const path = join(dir, 'media');
      await this.storage.downloadToFile(objectKey, path, signal);
      const { size } = await stat(path);
      return fn(new LocalMedia(path, size));
    });
  }
}

export class LocalMedia {
  constructor(
    readonly path: string,
    readonly sizeBytes: number,
  ) {}

  /** A web stream of the whole file, or of the inclusive byte range [start, end]. */
  stream(start = 0, end = this.sizeBytes - 1): ReadableStream<Uint8Array> {
    return Readable.toWeb(
      createReadStream(this.path, { start, end }),
    ) as ReadableStream<Uint8Array>;
  }

  /** Small files only (images): the bytes in memory. */
  async read(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(this.path))
      chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
}
