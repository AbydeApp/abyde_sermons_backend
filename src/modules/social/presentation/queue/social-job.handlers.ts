import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import {
  CHECK_PUBLICATION_JOB,
  COLLECT_METRICS_JOB,
  CollectPublicationMetricsUseCase,
  DISPATCH_SOCIAL_JOB,
  DispatchDueSocialPostsUseCase,
  PUBLISH_PUBLICATION_JOB,
  PublishPublicationUseCase,
  REFRESH_TOKENS_JOB,
  RefreshExpiringConnectionsUseCase,
  type SocialPublishJob,
  type SocialStatusJob,
} from '../../application/use-cases/publishing.use-cases.js';

@Injectable()
export class SocialJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(PublishPublicationUseCase)
    private readonly publish: PublishPublicationUseCase,
    @Inject(DispatchDueSocialPostsUseCase)
    private readonly dispatch: DispatchDueSocialPostsUseCase,
    @Inject(RefreshExpiringConnectionsUseCase)
    private readonly refresh: RefreshExpiringConnectionsUseCase,
    @Inject(CollectPublicationMetricsUseCase)
    private readonly metrics: CollectPublicationMetricsUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<SocialPublishJob>(
        PUBLISH_PUBLICATION_JOB,
        (payload, context) => this.publish.publish(payload, context),
      ),
    );
    this.registry.register(
      defineJobHandler<SocialStatusJob>(
        CHECK_PUBLICATION_JOB,
        (payload, context) => this.publish.check(payload, context),
      ),
    );
    const recurring = [
      { job: DISPATCH_SOCIAL_JOB, everyMs: 60_000, run: this.dispatch },
      { job: REFRESH_TOKENS_JOB, everyMs: 30 * 60_000, run: this.refresh },
      { job: COLLECT_METRICS_JOB, everyMs: 6 * 3600_000, run: this.metrics },
    ] as const;
    for (const { job, everyMs, run } of recurring) {
      this.registry.register(
        defineJobHandler(
          job,
          async (_payload, context) => void (await run.execute(context)),
        ),
      );
      this.registry.registerRecurring({
        queue: job.queue,
        jobName: job.name,
        everyMs,
      });
    }
  }
}
