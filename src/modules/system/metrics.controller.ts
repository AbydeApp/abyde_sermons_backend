import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { Public } from '../../shared/infrastructure/http/auth.decorators.js';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import { MetricsService } from '../../shared/infrastructure/observability/metrics.service.js';
import { QUEUE_INSPECTOR, type QueueInspector } from './queue-inspector.js';

/** Prometheus scrape endpoint (outside /api/v1). Requires the metrics bearer token when configured. */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(QUEUE_INSPECTOR) private readonly queues: QueueInspector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const token = this.config.OBSERVABILITY_METRICS_TOKEN;
    if (token) {
      const presented = Buffer.from(
        authorization?.replace(/^Bearer /, '') ?? '',
      );
      const expected = Buffer.from(token);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      )
        throw notFound('Resource');
    } else if (
      this.config.APP_ENV !== 'development' &&
      this.config.APP_ENV !== 'test'
    ) {
      throw notFound('Resource');
    }
    for (const queue of Object.values(QUEUES)) {
      const counts = await this.queues.counts(queue).catch(() => null);
      for (const [state, value] of Object.entries(counts ?? {}))
        this.metrics.queueDepth.set({ queue, state }, value);
    }
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
