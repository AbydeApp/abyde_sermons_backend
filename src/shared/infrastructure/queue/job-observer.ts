export const JOB_OBSERVER = Symbol('JOB_OBSERVER');

/** Hook for job metrics; implemented by the observability layer. */
export interface JobObserver {
  completed(queue: string, jobName: string, durationMs: number): void;
  failed(queue: string, jobName: string): void;
}

export const noopJobObserver: JobObserver = {
  completed: () => undefined,
  failed: () => undefined,
};
