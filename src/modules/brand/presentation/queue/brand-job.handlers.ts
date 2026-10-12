import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import {
  BRAND_RENDER_JOB,
  RECOVER_RENDERS_JOB,
  RecoverStuckRendersUseCase,
  RenderMediaGroupUseCase,
  type RenderJobPayload,
  VIDEO_RENDER_JOB,
} from '../../application/use-cases/render.use-cases.js';

@Injectable()
export class BrandJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(RenderMediaGroupUseCase)
    private readonly render: RenderMediaGroupUseCase,
    @Inject(RecoverStuckRendersUseCase)
    private readonly recover: RecoverStuckRendersUseCase,
  ) {}

  onModuleInit(): void {
    for (const job of [BRAND_RENDER_JOB, VIDEO_RENDER_JOB]) {
      this.registry.register(
        defineJobHandler<RenderJobPayload>(job, (payload, context) =>
          this.render.execute(payload, context),
        ),
      );
    }
    this.registry.register(
      defineJobHandler(
        RECOVER_RENDERS_JOB,
        async (_payload, context) => void (await this.recover.execute(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: RECOVER_RENDERS_JOB.queue,
      jobName: RECOVER_RENDERS_JOB.name,
      everyMs: 15 * 60_000,
    });
  }
}
