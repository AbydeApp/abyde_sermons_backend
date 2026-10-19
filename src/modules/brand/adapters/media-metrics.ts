import { Inject, Injectable } from '@nestjs/common';
import { Histogram } from 'prom-client';
import { MetricsService } from '../../../shared/infrastructure/observability/metrics.service.js';
import type { MediaObserverPort } from './ports.js';

/** Render duration per kind (images, carousels, clips) and outcome. */
@Injectable()
export class MediaMetrics implements MediaObserverPort {
  private readonly duration: Histogram;

  constructor(@Inject(MetricsService) metrics: MetricsService) {
    this.duration = new Histogram({
      name: 'media_render_duration_seconds',
      help: 'Branded media render duration',
      labelNames: ['kind', 'outcome'],
      buckets: [0.5, 1, 5, 15, 60, 180, 600, 1500],
      registers: [metrics.registry],
    });
  }

  rendered(kind: string, durationMs: number, ok: boolean): void {
    this.duration.observe(
      { kind, outcome: ok ? 'ok' : 'failed' },
      durationMs / 1000,
    );
  }
}
