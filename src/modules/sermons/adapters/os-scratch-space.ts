import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScratchSpacePort } from './ports.js';

export class OsScratchSpace implements ScratchSpacePort {
  constructor(private readonly baseDir: string = tmpdir()) {}

  async withDirectory<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(this.baseDir, 'abyde-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
