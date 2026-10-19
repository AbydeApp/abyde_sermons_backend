import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { SermonAnalysisService } from './adapters/sermon-analysis.js';
import { PipelineService } from './pipeline.service.js';
import { SermonsController } from './sermons.controller.js';
import { SermonsService } from './sermons.service.js';

/** Repositories and the transcription, media and storage adapters are bound by the composition root. */
@Module({
  imports: [UploadsModule],
  controllers: [SermonsController],
  providers: [SermonAnalysisService, SermonsService, PipelineService],
  exports: [SermonsService],
})
export class SermonsModule {}
