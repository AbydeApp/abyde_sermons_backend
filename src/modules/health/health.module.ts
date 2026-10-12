import { Module } from '@nestjs/common';
import { ShutdownDrain } from './application/shutdown-drain.js';
import { CheckReadinessUseCase } from './application/use-cases/check-readiness.use-case.js';
import { HealthController } from './presentation/http/health.controller.js';

/** Readiness checks (READINESS_CHECKS) are supplied by the infrastructure composition root. */
@Module({
  controllers: [HealthController],
  providers: [CheckReadinessUseCase, ShutdownDrain],
})
export class HealthModule {}
