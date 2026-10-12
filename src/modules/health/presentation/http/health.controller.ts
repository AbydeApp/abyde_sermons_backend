import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { Public } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { ShutdownDrain } from '../../application/shutdown-drain.js';
import { CheckReadinessUseCase } from '../../application/use-cases/check-readiness.use-case.js';

/** Mounted outside the /api/v1 prefix so load balancers can probe it. */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(CheckReadinessUseCase)
    private readonly checkReadiness: CheckReadinessUseCase,
    @Inject(ShutdownDrain) private readonly drain: ShutdownDrain,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness() {
    // Liveness (above) never checks dependencies; readiness does, and fails first during shutdown.
    if (this.drain.isDraining)
      throw new DomainError(
        'UNAVAILABLE',
        'NOT_READY',
        'Service is shutting down.',
      );
    const report = await this.checkReadiness.execute();
    if (!report.ready) {
      throw new DomainError(
        'UNAVAILABLE',
        'NOT_READY',
        'Service is not ready.',
      );
    }
    return { status: 'ready', checks: report.checks };
  }
}
