import type { QueueName } from './ports/queue.port.js';

export interface JobContext {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  readonly isFinalAttempt: boolean;
  /**
   * Aborts when the attempt must stop: its time limit passed, the worker is being shut down past
   * its grace period, or (recurring jobs) the shared lock was lost. Handlers pass it down to
   * the actual I/O so the work really stops.
   */
  signal: AbortSignal;
  /** Recurring jobs only: the lock's fencing token, which grows with every acquisition. */
  fencingToken?: number;
  /**
   * Recurring jobs only: rejects if a newer holder has taken over this job (this run paused past
   * its lease). Call it before each batch of writes.
   */
  assertCurrent?: () => Promise<void>;
}

/**
 * Inbound adapter contract for background work. Handlers translate a job payload into a use-case call;
 * the queue runtime (BullMQ in production, in-memory in tests) dispatches by queue + job name.
 */
export interface JobHandler<T = unknown> {
  readonly queue: QueueName;
  readonly jobName: string;
  handle(payload: T, context: JobContext): Promise<void>;
}

/** Thrown when retrying cannot succeed (bad input, missing data). The runtime stops retrying. */
export class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface RecurringJob {
  queue: QueueName;
  jobName: string;
  everyMs: number;
}

/** What a recurring use case needs to stop safely mid-run. */
export type RunGuard = Pick<JobContext, 'signal' | 'assertCurrent'>;

/** Stops the run if it was aborted or superseded by a newer holder. */
export async function checkpoint(guard?: RunGuard): Promise<void> {
  guard?.signal.throwIfAborted();
  await guard?.assertCurrent?.();
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly recurringJobs: RecurringJob[] = [];

  /** Declares a job the worker runtime triggers on a fixed interval (one schedule cluster-wide). */
  registerRecurring(job: RecurringJob): void {
    this.recurringJobs.push(job);
  }

  recurring(): readonly RecurringJob[] {
    return this.recurringJobs;
  }

  register(handler: JobHandler): void {
    this.handlers.set(
      JobHandlerRegistry.key(handler.queue, handler.jobName),
      handler,
    );
  }

  resolve(queue: QueueName, jobName: string): JobHandler | undefined {
    return this.handlers.get(JobHandlerRegistry.key(queue, jobName));
  }

  queues(): QueueName[] {
    return [...new Set([...this.handlers.values()].map((h) => h.queue))];
  }

  private static key(queue: string, jobName: string): string {
    return `${queue}:${jobName}`;
  }
}

export const JOB_HANDLER_REGISTRY = Symbol('JOB_HANDLER_REGISTRY');

export function defineJobHandler<T>(
  job: { queue: QueueName; name: string },
  handle: (payload: T, context: JobContext) => Promise<void>,
): JobHandler {
  return {
    queue: job.queue,
    jobName: job.name,
    handle: (payload, context) => handle(payload as T, context),
  };
}
