import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import {
  GENERATE_REEL_CANDIDATES_JOB,
  type ReelCandidatesJobPayload,
} from '../../../../shared/application/reel-jobs.js';
import {
  RECOVER_REELS_JOB,
  RENDER_REEL_JOB,
  type ReelRenderJobPayload,
} from '../../application/reel-jobs.js';
import { GenerateReelCandidatesUseCase } from '../../application/use-cases/reel-candidates.use-cases.js';
import {
  RecoverStuckReelsUseCase,
  RenderReelUseCase,
} from '../../application/use-cases/reel-render.use-cases.js';

/** Queue inbound adapters: each job payload becomes one use-case call. */
@Injectable()
export class ReelJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(GenerateReelCandidatesUseCase)
    private readonly candidates: GenerateReelCandidatesUseCase,
    @Inject(RenderReelUseCase) private readonly render: RenderReelUseCase,
    @Inject(RecoverStuckReelsUseCase)
    private readonly recover: RecoverStuckReelsUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<ReelCandidatesJobPayload>(
        GENERATE_REEL_CANDIDATES_JOB,
        (payload, context) => this.candidates.execute(payload, context),
      ),
    );
    this.registry.register(
      defineJobHandler<ReelRenderJobPayload>(
        RENDER_REEL_JOB,
        (payload, context) => this.render.execute(payload, context),
      ),
    );
    this.registry.register(
      defineJobHandler(
        RECOVER_REELS_JOB,
        async (_payload, context) => void (await this.recover.execute(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: RECOVER_REELS_JOB.queue,
      jobName: RECOVER_REELS_JOB.name,
      everyMs: 15 * 60_000,
    });
  }
}
