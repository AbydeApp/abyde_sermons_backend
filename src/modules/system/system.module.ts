import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { MetricsController } from './system.controller.js';
import { SystemService } from './system.service.js';

/** QUEUE_INSPECTOR, the email sender and repositories are bound by the composition root. */
@Module({
  imports: [UploadsModule],
  controllers: [MetricsController],
  providers: [SystemService],
})
export class SystemModule {}
