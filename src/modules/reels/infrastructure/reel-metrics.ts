import { Inject, Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../../../shared/infrastructure/observability/metrics.service.js';
import type { ReelObserverPort } from '../application/ports/out/reel.ports.js';

/** Reel render duration and outcomes, and how many candidates selection produces. */
@Injectable()
export class ReelMetrics implements ReelObserverPort {
  private readonly duration: Histogram;
  private readonly renders: Counter;
  private readonly candidates: Counter;

  constructor(@Inject(MetricsService) metrics: MetricsService) {
    this.duration = new Histogram({
      name: 'reel_render_duration_seconds',
      help: 'Reel render duration (download, tracking, encode, upload)',
      labelNames: ['outcome'],
      buckets: [10, 30, 60, 120, 300, 600, 1200, 1500],
      registers: [metrics.registry],
    });
    this.renders = new Counter({
      name: 'reels_rendered_total',
      help: 'Reel renders by outcome',
      labelNames: ['outcome'],
      registers: [metrics.registry],
    });
    this.candidates = new Counter({
      name: 'reel_candidates_generated_total',
      help: 'Reel candidates kept after validation',
      registers: [metrics.registry],
    });
  }

  rendered(durationMs: number, ok: boolean): void {
    const outcome = ok ? 'ok' : 'failed';
    this.duration.observe({ outcome }, durationMs / 1000);
    this.renders.inc({ outcome });
  }

  candidatesGenerated(count: number): void {
    this.candidates.inc(count);
  }
}
