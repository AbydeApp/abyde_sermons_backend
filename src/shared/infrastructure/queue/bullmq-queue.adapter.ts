import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type {
  EnqueueOptions,
  QueueName,
  QueuePort,
} from '../../application/ports/queue.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { QUEUE_POLICIES } from './queue-policies.js';
import { bullConnection } from './bullmq-connection.js';

@Injectable()
export class BullMqQueueAdapter implements QueuePort, OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async enqueue<T extends object>(
    queueName: QueueName,
    jobName: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<void> {
    // attempts, backoff and retention come from the queue's defaultJobOptions (set below).
    await this.queue(queueName).add(jobName, payload, {
      // BullMQ reserves ':' in custom ids; ids stay deterministic after substitution.
      jobId: options.jobId?.replace(/:/g, '.'),
      delay: options.delayMs,
      priority: options.priority,
    });
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      const policy = QUEUE_POLICIES[name];
      queue = new Queue(name, {
        connection: bullConnection(this.config.REDIS_URL),
        // Explicit for every queue: BullMQ does not retry by default and would keep finished
        // jobs in Redis forever.
        defaultJobOptions: {
          attempts: policy.attempts,
          backoff: { type: 'exponential', delay: policy.backoffMs },
          removeOnComplete: policy.discardOnComplete
            ? true
            : { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
