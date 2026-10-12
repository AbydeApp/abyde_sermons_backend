import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import {
  GENERATE_CONTENT_JOB,
  GenerateContentTypeUseCase,
  type GenerationJobPayload,
} from '../../application/use-cases/generation.use-cases.js';
import { RecoverStuckGenerationsUseCase } from '../../application/use-cases/recover-stuck-generations.use-case.js';
import { QUEUES } from '../../../../shared/application/ports/queue.port.js';

const RECOVER_STUCK_GENERATIONS_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'recover-stuck-generations',
} as const;

@Injectable()
export class ContentJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(GenerateContentTypeUseCase)
    private readonly generate: GenerateContentTypeUseCase,
    @Inject(RecoverStuckGenerationsUseCase)
    private readonly recoverStuck: RecoverStuckGenerationsUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<GenerationJobPayload>(
        GENERATE_CONTENT_JOB,
        (payload, context) => this.generate.execute(payload, context),
      ),
    );
    this.registry.register(
      defineJobHandler(
        RECOVER_STUCK_GENERATIONS_JOB,
        async (_payload, context) =>
          void (await this.recoverStuck.execute(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: RECOVER_STUCK_GENERATIONS_JOB.queue,
      jobName: RECOVER_STUCK_GENERATIONS_JOB.name,
      everyMs: 10 * 60 * 1000,
    });
  }
}
