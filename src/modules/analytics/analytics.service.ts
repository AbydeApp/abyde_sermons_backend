import { Inject, Injectable } from '@nestjs/common';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { lagosMonthRange } from '../../shared/domain/lagos-time.js';
import { SERMON_QUERY, type SermonQueryPort } from '../sermons/sermons.repository.js';
import { ANALYTICS_QUERY, type AnalyticsQueryPort } from './analytics.repository.js';
import {
  type AnalyticsView, type DashboardView, METRICS_TTL_SECONDS, metricsCacheKey, type ProductMetrics, toAnalyticsView,
  toDashboardView,
} from './helper.js';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(ANALYTICS_QUERY) private readonly query: AnalyticsQueryPort,
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async summary(churchId: string): Promise<AnalyticsView> {
    return toAnalyticsView(await this.metrics(churchId));
  }

  async dashboard(churchId: string): Promise<DashboardView> {
    const month = lagosMonthRange(this.clock.now());
    const [metrics, sermonsThisMonth, latestSermon] = await Promise.all([
      this.metrics(churchId),
      this.query.sermonsCreatedBetween(churchId, month.start, month.end),
      this.sermons.latest(churchId),
    ]);
    return toDashboardView(metrics, sermonsThisMonth, latestSermon);
  }

  private async metrics(churchId: string): Promise<ProductMetrics> {
    const key = metricsCacheKey(churchId);
    const cached = await this.cache.get<ProductMetrics>(key);
    if (cached) return cached;
    const metrics = await this.query.metrics(churchId);
    await this.cache.set(key, metrics, METRICS_TTL_SECONDS);
    return metrics;
  }
}
