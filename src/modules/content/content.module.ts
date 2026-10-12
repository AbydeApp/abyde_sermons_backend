import { Module } from '@nestjs/common';
import { ContentPresenter } from './application/content-presenter.js';
import { SERMON_CONTEXT } from './application/ports/out/sermon-context.port.js';
import { ContentGenerationService } from './application/services/content-generation.service.js';
import {
  ListCalendarUseCase,
  RescheduleCalendarItemUseCase,
  ScheduleContentUseCase,
  UnscheduleCalendarItemUseCase,
} from './application/use-cases/calendar.use-cases.js';
import {
  ApproveContentUseCase,
  ContentMutations,
  DeleteContentUseCase,
  GetContentUseCase,
  ListContentUseCase,
  ListContentVersionsUseCase,
  RegenerateContentUseCase,
  RestoreContentVersionUseCase,
  RewriteContentUseCase,
  UpdateContentUseCase,
} from './application/use-cases/content.use-cases.js';
import {
  GenerateContentTypeUseCase,
  GenerateWeekUseCase,
  GetGenerationGroupUseCase,
} from './application/use-cases/generation.use-cases.js';
import { RecoverStuckGenerationsUseCase } from './application/use-cases/recover-stuck-generations.use-case.js';
import { SermonContextAdapter } from './infrastructure/sermon-context.adapter.js';
import { CalendarController } from './presentation/http/calendar.controller.js';
import { ContentController } from './presentation/http/content.controller.js';
import { GenerationController } from './presentation/http/generation.controller.js';
import { ContentJobHandlers } from './presentation/queue/content-job.handlers.js';

/** Content lifecycle: generation (B15–B20), CRUD + versions (B21), calendar (B22). */
@Module({
  controllers: [ContentController, GenerationController, CalendarController],
  providers: [
    { provide: SERMON_CONTEXT, useClass: SermonContextAdapter },
    ContentGenerationService,
    ContentPresenter,
    ContentMutations,
    GenerateWeekUseCase,
    GetGenerationGroupUseCase,
    GenerateContentTypeUseCase,
    RecoverStuckGenerationsUseCase,
    ListContentUseCase,
    GetContentUseCase,
    UpdateContentUseCase,
    ApproveContentUseCase,
    RewriteContentUseCase,
    RegenerateContentUseCase,
    DeleteContentUseCase,
    ListContentVersionsUseCase,
    RestoreContentVersionUseCase,
    ListCalendarUseCase,
    ScheduleContentUseCase,
    RescheduleCalendarItemUseCase,
    UnscheduleCalendarItemUseCase,
    ContentJobHandlers,
  ],
  exports: [ContentPresenter],
})
export class ContentModule {}
