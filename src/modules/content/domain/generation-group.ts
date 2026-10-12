import type { ContentType, JobStatus } from './content-types.js';

export interface GenerationJobRecord {
  id: string;
  groupId: string;
  churchId: string;
  sermonId: string;
  contentType: ContentType;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
}

export interface GenerationGroupRecord {
  id: string;
  churchId: string;
  sermonId: string;
  createdAt: Date;
  jobs: GenerationJobRecord[];
}

export const isTerminal = (status: JobStatus): boolean =>
  status === 'COMPLETED' || status === 'FAILED';

export const isGroupDone = (group: GenerationGroupRecord): boolean =>
  group.jobs.every((job) => isTerminal(job.status));

/**
 * Decides how a generate-week request maps onto the latest group, so "Retry failed" never duplicates work.
 * Reuse the latest group when it still has unfinished or failed work for the requested types; in it,
 * FAILED types are re-queued, in-flight and COMPLETED types are left alone, unseen types are added.
 * Otherwise (no group, or every requested type already completed) start a fresh group.
 */
export function planGeneration(
  latest: GenerationGroupRecord | null,
  requested: ContentType[],
): { reuse: boolean; requeue: ContentType[]; add: ContentType[] } {
  const types = [...new Set(requested)];
  if (latest) {
    const byType = new Map(latest.jobs.map((job) => [job.contentType, job]));
    const reusable = types.some((type) => {
      const job = byType.get(type);
      return job !== undefined && job.status !== 'COMPLETED';
    });
    if (reusable) {
      return {
        reuse: true,
        requeue: types.filter((type) => byType.get(type)?.status === 'FAILED'),
        add: types.filter((type) => !byType.has(type)),
      };
    }
  }
  return { reuse: false, requeue: [], add: types };
}
