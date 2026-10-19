import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../shared/infrastructure/http/auth.decorators.js';
import { SystemService } from './system.service.js';

/** Prometheus scrape endpoint (outside /api/v1). */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  @Get()
  async scrape(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    const { contentType, body } = await this.system.scrape(authorization);
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }
}
