import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../shared/infrastructure/http/auth.decorators.js';
import { HealthService } from './health.service.js';
import type { ReadinessResponse } from './helper.js';

/** Mounted outside the /api/v1 prefix so load balancers can probe it. */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  liveness(): { status: 'ok' } {
    return this.health.liveness();
  }

  @Get('ready')
  readiness(): Promise<ReadinessResponse> {
    return this.health.readiness();
  }
}
