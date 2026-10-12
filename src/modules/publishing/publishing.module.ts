import { Module } from '@nestjs/common';
import {
  DispatchDuePublicationsUseCase,
  PublishCalendarItemUseCase,
} from './application/use-cases/publishing.use-cases.js';
import { PublishingJobHandlers } from './presentation/queue/publishing-job.handlers.js';

/** Background publishing (B26). Provider adapters are bound by the infrastructure composition root. */
@Module({
  providers: [
    DispatchDuePublicationsUseCase,
    PublishCalendarItemUseCase,
    PublishingJobHandlers,
  ],
})
export class PublishingModule {}
