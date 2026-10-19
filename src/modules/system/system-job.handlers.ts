import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../shared/application/jobs.js';
import {
  EMAIL_SENDER,
  type EmailMessage,
  type EmailSenderPort,
} from '../../shared/application/ports/email.port.js';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { PurgeOldRecordsUseCase } from './purge-old-records.use-case.js';
import { UploadsService } from '../uploads/uploads.service.js';

const SEND_EMAIL_JOB = { queue: QUEUES.EMAIL, name: 'send' } as const;
const PURGE_OLD_RECORDS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'purge-old-records',
} as const;
const PURGE_UPLOADS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'purge-stale-uploads',
} as const;

/** Transactional email delivery (retried by the queue) and periodic housekeeping. */
@Injectable()
export class SystemJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(EMAIL_SENDER) private readonly email: EmailSenderPort,
    @Inject(UploadsService)
    private readonly uploads: UploadsService,
    @Inject(PurgeOldRecordsUseCase)
    private readonly purgeOldRecords: PurgeOldRecordsUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<EmailMessage>(SEND_EMAIL_JOB, (message) =>
        this.email.send(message),
      ),
    );
    this.registry.register(
      defineJobHandler(
        PURGE_UPLOADS_JOB,
        async (_payload, context) =>
          void (await this.uploads.purgeStale(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: PURGE_UPLOADS_JOB.queue,
      jobName: PURGE_UPLOADS_JOB.name,
      everyMs: 6 * 3600 * 1000,
    });
    this.registry.register(
      defineJobHandler(
        PURGE_OLD_RECORDS_JOB,
        async () => void (await this.purgeOldRecords.execute()),
      ),
    );
    this.registry.registerRecurring({
      queue: PURGE_OLD_RECORDS_JOB.queue,
      jobName: PURGE_OLD_RECORDS_JOB.name,
      everyMs: 24 * 3600 * 1000,
    });
  }
}
