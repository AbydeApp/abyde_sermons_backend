import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/** Readiness checks (READINESS_CHECKS) are supplied by the infrastructure composition root. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
