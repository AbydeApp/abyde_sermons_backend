import { Inject, Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../../../shared/infrastructure/observability/metrics.service.js';
import type { SocialObserverPort } from '../application/ports/out/social-support.ports.js';

/**
 * Prometheus metrics for social publishing: provider calls (per operation, which is also the X
 * billable-operation count), publication outcomes and latency, and token refreshes. Labels never
 * carry church ids or other unbounded values.
 */
@Injectable()
export class SocialMetrics implements SocialObserverPort {
  private readonly calls: Counter;
  private readonly callDuration: Histogram;
  private readonly publications: Counter;
  private readonly publishLatency: Histogram;
  private readonly refreshes: Counter;

  constructor(@Inject(MetricsService) metrics: MetricsService) {
    const registers = [metrics.registry];
    this.calls = new Counter({
      name: 'social_provider_calls_total',
      help: 'Social provider API calls by operation and outcome',
      labelNames: ['provider', 'operation', 'outcome', 'error_code'],
      registers,
    });
    this.callDuration = new Histogram({
      name: 'social_provider_call_duration_seconds',
      help: 'Social provider API latency',
      labelNames: ['provider', 'operation'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 120],
      registers,
    });
    this.publications = new Counter({
      name: 'social_publications_total',
      help: 'Publication outcomes per platform',
      labelNames: ['platform', 'outcome', 'error_code'],
      registers,
    });
    this.publishLatency = new Histogram({
      name: 'social_publication_latency_seconds',
      help: 'From queueing to a final publication outcome',
      labelNames: ['platform'],
      buckets: [1, 5, 15, 60, 300, 900, 3600],
      registers,
    });
    this.refreshes = new Counter({
      name: 'social_token_refresh_total',
      help: 'Token refreshes, expiries (reconnect needed) and failures',
      labelNames: ['provider', 'outcome'],
      registers,
    });
  }

  providerCall(event: Parameters<SocialObserverPort['providerCall']>[0]): void {
    this.calls.inc({
      provider: event.provider,
      operation: event.operation,
      outcome: event.outcome,
      error_code: event.errorCode ?? '',
    });
    this.callDuration.observe(
      { provider: event.provider, operation: event.operation },
      event.durationMs / 1000,
    );
  }

  publication(event: Parameters<SocialObserverPort['publication']>[0]): void {
    this.publications.inc({
      platform: event.platform,
      outcome: event.outcome,
      error_code: event.errorCode ?? '',
    });
    if (event.latencyMs !== undefined)
      this.publishLatency.observe(
        { platform: event.platform },
        event.latencyMs / 1000,
      );
  }

  tokenRefresh(event: Parameters<SocialObserverPort['tokenRefresh']>[0]): void {
    this.refreshes.inc(event);
  }
}
