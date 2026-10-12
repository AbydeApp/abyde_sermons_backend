import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { MetricsController } from './metrics.controller.js';
import { PurgeOldRecordsUseCase } from './purge-old-records.use-case.js';
import { RuntimeChecks } from './runtime-checks.js';
import { SystemJobHandlers } from './system-job.handlers.js';

@Module({
  imports: [UploadsModule],
  controllers: [MetricsController],
  providers: [SystemJobHandlers, PurgeOldRecordsUseCase, RuntimeChecks],
})
export class SystemModule {}
