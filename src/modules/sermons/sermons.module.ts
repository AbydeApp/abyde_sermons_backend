import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { SermonAnalysisService } from './application/services/sermon-analysis.service.js';
import {
  CreateSermonUseCase,
  DeleteSermonUseCase,
  GetIntelligenceUseCase,
  GetSermonStatusUseCase,
  GetSermonUseCase,
  GetTranscriptUseCase,
  ListSermonsUseCase,
  RetrySermonUseCase,
  UpdateSermonUseCase,
} from './application/use-cases/sermon-crud.use-cases.js';
import {
  AnalyzeSermonUseCase,
  IndexSermonUseCase,
  SermonPipelineSupport,
  StartSermonProcessingUseCase,
  TranscribeSermonUseCase,
} from './application/use-cases/sermon-pipeline.use-cases.js';
import { PurgeExpiredSourcesUseCase } from './application/use-cases/purge-expired-sources.use-case.js';
import { RecoverStuckSermonsUseCase } from './application/use-cases/recover-stuck-sermons.use-case.js';
import { SermonsController } from './presentation/http/sermons.controller.js';
import { SermonJobHandlers } from './presentation/queue/sermon-job.handlers.js';

@Module({
  imports: [UploadsModule],
  controllers: [SermonsController],
  providers: [
    SermonAnalysisService,
    CreateSermonUseCase,
    ListSermonsUseCase,
    GetSermonUseCase,
    UpdateSermonUseCase,
    DeleteSermonUseCase,
    GetSermonStatusUseCase,
    RetrySermonUseCase,
    GetTranscriptUseCase,
    GetIntelligenceUseCase,
    SermonPipelineSupport,
    StartSermonProcessingUseCase,
    TranscribeSermonUseCase,
    AnalyzeSermonUseCase,
    IndexSermonUseCase,
    RecoverStuckSermonsUseCase,
    PurgeExpiredSourcesUseCase,
    SermonJobHandlers,
  ],
  exports: [GetSermonUseCase],
})
export class SermonsModule {}
