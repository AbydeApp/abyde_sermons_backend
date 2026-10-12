import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { LockNotAcquiredError, Locks } from '@nestjs/locks';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
  PermanentJobError,
} from '../../application/jobs.js';
import type { QueueName } from '../../application/ports/queue.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { reportError } from '../observability/error-reporter.js';
import { JOB_OBSERVER, type JobObserver } from './job-observer.js';
import { FencingRegistry } from '../locks/fencing-registry.js';
import { bullConnection } from './bullmq-connection.js';
import { QUEUE_POLICIES } from './queue-policies.js';
import { BullMqQueueAdapter } from './bullmq-queue.adapter.js';

/** Worker-process inbound adapter: consumes BullMQ jobs and dispatches them to registered handlers. */
@Injectable()
export class BullMqWorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BullMqWorkerHost.name);
  private readonly workers: Worker[] = [];
  private readonly forcedShutdown = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(JOB_OBSERVER) private readonly observer: JobObserver,
    @Inject(BullMqQueueAdapter) private readonly queues: BullMqQueueAdapter,
    @Inject(Locks) private readonly locks: Locks,
    @Inject(FencingRegistry) private readonly fencing: FencingRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const queue of this.registry.queues()) {
      const worker = new Worker(queue, (job) => this.process(queue, job), {
        connection: bullConnection(this.config.REDIS_URL),
        concurrency: Math.min(
          this.config.WORKER_CONCURRENCY,
          QUEUE_POLICIES[queue].maxConcurrency ?? Number.POSITIVE_INFINITY,
        ),
      });
      worker.on('error', (error) =>
        this.logger.error({ queue, err: error }, 'Worker error'),
      );
      this.workers.push(worker);
    }
    // Job schedulers are idempotent upserts keyed by id, so N worker replicas still produce one schedule.
    for (const job of this.registry.recurring()) {
      await this.queues.queue(job.queue).upsertJobScheduler(
        `${job.queue}:${job.jobName}`,
        { every: job.everyMs },
        {
          name: job.jobName,
          data: {},
          // Recurring jobs run every minute or so: keep only a short history in Redis.
          opts: {
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 100 },
          },
        },
      );
    }
    this.logger.log(
      `Workers started for queues: ${this.registry.queues().join(', ')}`,
    );
  }

  private isRecurring(queue: QueueName, jobName: string): boolean {
    return this.registry
      .recurring()
      .some((job) => job.queue === queue && job.jobName === jobName);
  }

  private async process(queue: QueueName, job: Job): Promise<void> {
    const handler = this.registry.resolve(queue, job.name);
    if (!handler)
      throw new UnrecoverableError(`No handler for ${queue}:${job.name}`);
    // Scheduler-created jobs carry no attempts option and BullMQ then runs them once.
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();
    const log = { queue, jobName: job.name, jobId: job.id, attempt };
    try {
      // The attempt stops when its time limit passes or the worker is forced to shut down.
      const limits = AbortSignal.any([
        AbortSignal.timeout(QUEUE_POLICIES[queue].timeoutMs),
        this.forcedShutdown.signal,
      ]);
      const context = {
        jobId: job.id ?? 'unknown',
        attempt,
        maxAttempts,
        isFinalAttempt: attempt >= maxAttempts,
      };
      if (this.isRecurring(queue, job.name)) {
        // A scheduled tick runs on exactly one instance, and is skipped while the previous run is
        // still going. The lock lives in Redis and renews itself while the handler runs.
        const lockKey = `recurring-job:${queue}:${job.name}`;
        try {
          await this.locks.withLock(lockKey, async (lock) => {
            await this.fencing.advance(lockKey, lock.fencingToken);
            await handler.handle(job.data, {
              ...context,
              signal: AbortSignal.any([limits, lock.signal]),
              fencingToken: lock.fencingToken,
              assertCurrent: () =>
                this.fencing.assertCurrent(lockKey, lock.fencingToken),
            });
          });
        } catch (error) {
          if (!(error instanceof LockNotAcquiredError)) throw error;
          this.logger.log(
            log,
            'Skipped scheduled tick: previous run still in progress',
          );
          return;
        }
      } else {
        await handler.handle(job.data, { ...context, signal: limits });
      }
      this.observer.completed(queue, job.name, Date.now() - startedAt);
      this.logger.log(log, 'Job completed');
    } catch (error) {
      this.observer.failed(queue, job.name);
      this.logger.warn({ ...log, err: error }, 'Job failed');
      if (attempt >= maxAttempts || error instanceof PermanentJobError)
        reportError(error, log);
      if (error instanceof PermanentJobError)
        throw new UnrecoverableError(error.message);
      throw error;
    }
  }

  /**
   * Running jobs get the shutdown grace period to finish. After that their abort signal fires and
   * the workers are closed anyway; BullMQ re-runs an interrupted job (every job is safe to run twice).
   */
  async onModuleDestroy(): Promise<void> {
    const graceful = Promise.all(this.workers.map((worker) => worker.close()));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        this.config.WORKER_SHUTDOWN_GRACE_MS,
      );
    });
    const outcome = await Promise.race([
      graceful.then(() => 'closed' as const),
      deadline,
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn('Shutdown grace period passed; aborting running jobs');
      this.forcedShutdown.abort(new Error('Worker shutting down'));
      await Promise.all(this.workers.map((worker) => worker.close(true)));
    }
  }
}
