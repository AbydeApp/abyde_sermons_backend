import {
  JobHandlerRegistry,
  PermanentJobError,
} from '../../src/shared/application/jobs.js';
import type {
  EnqueueOptions,
  QueueName,
  QueuePort,
} from '../../src/shared/application/ports/queue.port.js';
import { QUEUE_POLICIES } from '../../src/shared/infrastructure/queue/queue-policies.js';

export interface RecordedJob {
  id: string;
  queue: QueueName;
  name: string;
  payload: object;
  attemptsMade: number;
  state: 'waiting' | 'completed' | 'failed';
  error?: string;
  priority?: number;
}

/**
 * Test/dev queue that runs jobs through the same handler registry as the BullMQ worker.
 * `drain()` processes jobs (including ones enqueued by handlers) with the real retry policy.
 */
export class InMemoryQueueAdapter implements QueuePort {
  readonly jobs: RecordedJob[] = [];
  private sequence = 0;

  constructor(private readonly registry: JobHandlerRegistry) {}

  async enqueue<T extends object>(
    queue: QueueName,
    name: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<void> {
    const id = options.jobId ?? `job-${++this.sequence}`;
    // Like BullMQ: adding a job whose id already exists (in any state) is ignored.
    if (this.jobs.some((job) => job.id === id)) return;
    this.jobs.push({
      id,
      queue,
      name,
      payload,
      attemptsMade: 0,
      state: 'waiting',
      priority: options.priority,
    });
  }

  async drain(maxIterations = 1_000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const job = this.jobs.find((candidate) => candidate.state === 'waiting');
      if (!job) return;
      await this.run(job);
    }
    throw new Error('InMemoryQueueAdapter.drain exceeded max iterations');
  }

  private async run(job: RecordedJob): Promise<void> {
    const handler = this.registry.resolve(job.queue, job.name);
    if (!handler) throw new Error(`No handler for ${job.queue}:${job.name}`);
    const maxAttempts = QUEUE_POLICIES[job.queue].attempts;
    while (job.state === 'waiting') {
      const attempt = job.attemptsMade + 1;
      try {
        await handler.handle(job.payload, {
          jobId: job.id,
          attempt,
          maxAttempts,
          isFinalAttempt: attempt >= maxAttempts,
          signal: new AbortController().signal,
        });
        job.state = 'completed';
      } catch (error) {
        job.attemptsMade = attempt;
        job.error = error instanceof Error ? error.message : String(error);
        if (error instanceof PermanentJobError || attempt >= maxAttempts)
          job.state = 'failed';
      }
    }
  }
}
