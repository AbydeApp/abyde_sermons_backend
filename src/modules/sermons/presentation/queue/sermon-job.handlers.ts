import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import { QUEUES } from '../../../../shared/application/ports/queue.port.js';
import type { SermonJobPayload } from '../../application/sermon-jobs.js';
import { PurgeExpiredSourcesUseCase } from '../../application/use-cases/purge-expired-sources.use-case.js';
import { RecoverStuckSermonsUseCase } from '../../application/use-cases/recover-stuck-sermons.use-case.js';
import { SERMON_JOBS } from '../../application/sermon-jobs.js';
import {
  AnalyzeSermonUseCase,
  IndexSermonUseCase,
  StartSermonProcessingUseCase,
  TranscribeSermonUseCase,
} from '../../application/use-cases/sermon-pipeline.use-cases.js';

const RECOVER_STUCK_SERMONS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'recover-stuck-sermons',
} as const;

const PURGE_EXPIRED_SOURCES_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'purge-expired-sermon-sources',
} as const;

/** Queue inbound adapters: translate job payloads into pipeline use-case calls. */
@Injectable()
export class SermonJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(StartSermonProcessingUseCase)
    private readonly start: StartSermonProcessingUseCase,
    @Inject(TranscribeSermonUseCase)
    private readonly transcribe: TranscribeSermonUseCase,
    @Inject(AnalyzeSermonUseCase)
    private readonly analyze: AnalyzeSermonUseCase,
    @Inject(IndexSermonUseCase) private readonly index: IndexSermonUseCase,
    @Inject(RecoverStuckSermonsUseCase)
    private readonly recoverStuck: RecoverStuckSermonsUseCase,
    @Inject(PurgeExpiredSourcesUseCase)
    private readonly purgeExpired: PurgeExpiredSourcesUseCase,
  ) {}

  onModuleInit(): void {
    const handlers = [
      defineJobHandler<SermonJobPayload>(SERMON_JOBS.START, (p, c) =>
        this.start.execute(p, c),
      ),
      defineJobHandler<SermonJobPayload>(SERMON_JOBS.TRANSCRIBE, (p, c) =>
        this.transcribe.execute(p, c),
      ),
      defineJobHandler<SermonJobPayload>(SERMON_JOBS.ANALYZE, (p, c) =>
        this.analyze.execute(p, c),
      ),
      defineJobHandler<SermonJobPayload>(SERMON_JOBS.INDEX, (p, c) =>
        this.index.execute(p, c),
      ),
    ];
    for (const handler of handlers) this.registry.register(handler);
    this.registry.register(
      defineJobHandler(
        RECOVER_STUCK_SERMONS_JOB,
        async (_payload, context) =>
          void (await this.recoverStuck.execute(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: RECOVER_STUCK_SERMONS_JOB.queue,
      jobName: RECOVER_STUCK_SERMONS_JOB.name,
      everyMs: 10 * 60 * 1000,
    });
    this.registry.register(
      defineJobHandler(
        PURGE_EXPIRED_SOURCES_JOB,
        async (_payload, context) =>
          void (await this.purgeExpired.execute(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: PURGE_EXPIRED_SOURCES_JOB.queue,
      jobName: PURGE_EXPIRED_SOURCES_JOB.name,
      everyMs: 60 * 60 * 1000,
    });
  }
}
