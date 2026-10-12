import { Inject, Injectable } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import { lagosMonthRange } from '../../../../shared/domain/lagos-time.js';
import {
  SERMON_QUERY,
  type SermonQueryPort,
  type SermonView,
} from '../../../sermons/application/ports/out/sermon-repository.port.js';
import {
  ANALYTICS_QUERY,
  type AnalyticsQueryPort,
  type ProductMetrics,
} from '../ports/out/analytics-query.port.js';

const METRICS_TTL_SECONDS = 30;

export interface AnalyticsView extends ProductMetrics {
  /** Null until a publishing provider returns real reach/engagement numbers — never fabricated. */
  publishingMetrics: null;
}

export interface DashboardView {
  sermonsThisMonth: number;
  contentGenerated: number;
  scheduled: number;
  published: number;
  latestSermon: SermonView | null;
}

@Injectable()
export class GetAnalyticsUseCase {
  constructor(
    @Inject(ANALYTICS_QUERY) private readonly analytics: AnalyticsQueryPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async metrics(churchId: string): Promise<ProductMetrics> {
    const key = `analytics:${churchId}`;
    const cached = await this.cache.get<ProductMetrics>(key);
    if (cached) return cached;
    const metrics = await this.analytics.metrics(churchId);
    await this.cache.set(key, metrics, METRICS_TTL_SECONDS);
    return metrics;
  }

  async execute(churchId: string): Promise<AnalyticsView> {
    return { ...(await this.metrics(churchId)), publishingMetrics: null };
  }
}

@Injectable()
export class GetDashboardUseCase {
  constructor(
    @Inject(GetAnalyticsUseCase)
    private readonly analytics: GetAnalyticsUseCase,
    @Inject(ANALYTICS_QUERY) private readonly query: AnalyticsQueryPort,
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string): Promise<DashboardView> {
    const month = lagosMonthRange(this.clock.now());
    const [metrics, sermonsThisMonth, latestSermon] = await Promise.all([
      this.analytics.metrics(churchId),
      this.query.sermonsCreatedBetween(churchId, month.start, month.end),
      this.sermons.latest(churchId),
    ]);
    return {
      sermonsThisMonth,
      contentGenerated: metrics.contentGenerated,
      scheduled: metrics.contentScheduled,
      published: metrics.contentPublished,
      latestSermon,
    };
  }
}
