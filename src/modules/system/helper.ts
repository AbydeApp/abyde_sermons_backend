import { readFile } from 'node:fs/promises';
import { QUEUES } from '../../shared/application/ports/queue.port.js';

// ───────────────────────── Jobs ─────────────────────────

export const SEND_EMAIL_JOB = { queue: QUEUES.EMAIL, name: 'send' } as const;
export const PURGE_OLD_RECORDS_JOB = { queue: QUEUES.MAINTENANCE, name: 'purge-old-records' } as const;
export const PURGE_UPLOADS_JOB = { queue: QUEUES.MAINTENANCE, name: 'purge-stale-uploads' } as const;
export const PURGE_UPLOADS_EVERY_MS = 6 * 3600 * 1000;
export const PURGE_OLD_RECORDS_EVERY_MS = 24 * 3600 * 1000;

const DAY_MS = 24 * 3600 * 1000;
/** Webhook records only guard against replays; providers stop redelivering within days. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 90;
/** AI cost logs feed unit-economics reporting; thirteen months keeps a full year-on-year comparison. */
export const AI_USAGE_LOG_RETENTION_DAYS = 400;
export const retentionCutoff = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

// ───────────────────────── Heap limit ─────────────────────────

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

export const heapTooHighMessage = (heapLimitMb: number, containerLimitMb: number | null) =>
  `Heap limit ${heapLimitMb} MB is above 85% of the ${containerLimitMb} MB container limit. Set --max-old-space-size to about 75% of the container memory limit.`;

export const heapWarning = (verdict: HeapVerdict) =>
  `Heap limit is ${verdict.replace('-', ' ')} for this container; set --max-old-space-size to about 75% of its memory limit`;
