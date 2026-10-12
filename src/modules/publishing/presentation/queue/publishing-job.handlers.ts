import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import {
  DISPATCH_JOB,
  DispatchDuePublicationsUseCase,
  PUBLISH_JOB,
  PublishCalendarItemUseCase,
  type PublishJobPayload,
} from '../../application/use-cases/publishing.use-cases.js';

@Injectable()
export class PublishingJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(DispatchDuePublicationsUseCase)
    private readonly dispatch: DispatchDuePublicationsUseCase,
    @Inject(PublishCalendarItemUseCase)
    private readonly publish: PublishCalendarItemUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler(
        DISPATCH_JOB,
        async (_payload, context) =>
          void (await this.dispatch.execute(context)),
      ),
    );
    this.registry.register(
      defineJobHandler<PublishJobPayload>(PUBLISH_JOB, (payload, context) =>
        this.publish.execute(payload, context),
      ),
    );
    this.registry.registerRecurring({
      queue: DISPATCH_JOB.queue,
      jobName: DISPATCH_JOB.name,
      everyMs: 60_000,
    });
  }
}
