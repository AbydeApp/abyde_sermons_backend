import type { SermonView } from '../sermons/application/ports/out/sermon-repository.port.js';

/** How long a church's metrics are reused before the database is asked again. */
export const METRICS_TTL_SECONDS = 30;
export const metricsCacheKey = (churchId: string) => `analytics:${churchId}`;

export interface ProductMetrics {
  sermonsUploaded: number;
  sermonsProcessed: number;
  contentGenerated: number;
  contentApproved: number;
  contentScheduled: number;
  contentPublished: number;
  processingFailures: number;
  generationFailures: number;
}

export interface AnalyticsView extends ProductMetrics {
  /** Null until a publishing provider returns real reach/engagement numbers, never fabricated. */
  publishingMetrics: null;
}

export interface DashboardView {
  sermonsThisMonth: number;
  contentGenerated: number;
  scheduled: number;
  published: number;
  latestSermon: SermonView | null;
}

export const toAnalyticsView = (metrics: ProductMetrics): AnalyticsView => ({
  ...metrics,
  publishingMetrics: null,
});

export const toDashboardView = (
  metrics: ProductMetrics,
  sermonsThisMonth: number,
  latestSermon: SermonView | null,
): DashboardView => ({
  sermonsThisMonth,
  contentGenerated: metrics.contentGenerated,
  scheduled: metrics.contentScheduled,
  published: metrics.contentPublished,
  latestSermon,
});
