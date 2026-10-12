import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';

const CGROUP_LIMIT_FILES = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
];
/** Above this, cgroup files report "no limit" (a huge sentinel value). */
const NO_LIMIT_BYTES = 2 ** 50;

export type HeapVerdict = 'ok' | 'too-high' | 'too-low' | 'unlimited';

/** `--max-old-space-size` should be about 75% of the container memory limit. */
export function judgeHeapLimit(
  heapLimitBytes: number,
  containerLimitBytes: number | null,
): HeapVerdict {
  if (containerLimitBytes === null) return 'unlimited';
  const ratio = heapLimitBytes / containerLimitBytes;
  if (ratio > 0.85) return 'too-high';
  if (ratio < 0.5) return 'too-low';
  return 'ok';
}

export async function readContainerMemoryLimit(
  files = CGROUP_LIMIT_FILES,
): Promise<number | null> {
  for (const file of files) {
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw === null) continue;
    const bytes = Number(raw.trim());
    return Number.isFinite(bytes) && bytes > 0 && bytes < NO_LIMIT_BYTES
      ? bytes
      : null;
  }
  return null;
}

/**
 * Checks at boot that the V8 heap limit fits the container. If the heap may grow past the
 * container limit, a leak ends in a silent kernel kill (exit 137) instead of a heap error with a
 * stack trace, so a deployed environment refuses to start that way.
 */
@Injectable()
export class RuntimeChecks implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeChecks.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onApplicationBootstrap(): Promise<void> {
    const heapLimit = getHeapStatistics().heap_size_limit;
    const containerLimit = await readContainerMemoryLimit();
    const verdict = judgeHeapLimit(heapLimit, containerLimit);
    const details = {
      heapLimitMb: Math.round(heapLimit / 1024 ** 2),
      containerLimitMb:
        containerLimit === null ? null : Math.round(containerLimit / 1024 ** 2),
    };
    if (verdict === 'ok' || verdict === 'unlimited') return;
    const deployed =
      this.config.APP_ENV === 'production' || this.config.APP_ENV === 'staging';
    if (verdict === 'too-high' && deployed) {
      throw new Error(
        `Heap limit ${details.heapLimitMb} MB is above 85% of the ${details.containerLimitMb} MB container limit. Set --max-old-space-size to about 75% of the container memory limit.`,
      );
    }
    this.logger.warn(
      details,
      `Heap limit is ${verdict.replace('-', ' ')} for this container; set --max-old-space-size to about 75% of its memory limit`,
    );
  }
}
