import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeHeapLimit, readContainerMemoryLimit } from './runtime-checks.js';

const MB = 1024 ** 2;

describe('heap limit check', () => {
  it('accepts roughly 75% of the container limit and flags anything else', () => {
    expect(judgeHeapLimit(384 * MB, 512 * MB)).toBe('ok');
    expect(judgeHeapLimit(1536 * MB, 2048 * MB)).toBe('ok');
    expect(judgeHeapLimit(4096 * MB, 512 * MB)).toBe('too-high');
    expect(judgeHeapLimit(480 * MB, 512 * MB)).toBe('too-high');
    expect(judgeHeapLimit(128 * MB, 2048 * MB)).toBe('too-low');
    expect(judgeHeapLimit(384 * MB, null)).toBe('unlimited');
  });

  it('reads the cgroup limit and treats "max" as no limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cgroup-'));
    await writeFile(join(dir, 'limited'), '536870912\n');
    await writeFile(join(dir, 'unlimited'), 'max\n');
    expect(
      await readContainerMemoryLimit([
        join(dir, 'missing'),
        join(dir, 'limited'),
      ]),
    ).toBe(536870912);
    expect(await readContainerMemoryLimit([join(dir, 'unlimited')])).toBeNull();
    expect(await readContainerMemoryLimit([join(dir, 'missing')])).toBeNull();
  });
});
