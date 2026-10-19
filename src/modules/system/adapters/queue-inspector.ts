import { Inject, Injectable } from '@nestjs/common';
import type { QueueName } from '../../../shared/application/ports/queue.port.js';
import { BullMqQueueAdapter } from '../../../shared/infrastructure/queue/bullmq-queue.adapter.js';

export const QUEUE_INSPECTOR = Symbol('QUEUE_INSPECTOR');

export interface QueueInspector {
  counts(queue: QueueName): Promise<Record<string, number>>;
}

/** Queue health for metrics/failed-job visibility. */
@Injectable()
export class BullMqQueueInspector implements QueueInspector {
  constructor(
    @Inject(BullMqQueueAdapter) private readonly queues: BullMqQueueAdapter,
  ) {}

  counts(queue: QueueName): Promise<Record<string, number>> {
    return this.queues
      .queue(queue)
      .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }
}

export const emptyQueueInspector: QueueInspector = { counts: async () => ({}) };
