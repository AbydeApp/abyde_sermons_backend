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

export const ANALYTICS_QUERY = Symbol('ANALYTICS_QUERY');

export interface AnalyticsQueryPort {
  metrics(churchId: string): Promise<ProductMetrics>;
  sermonsCreatedBetween(
    churchId: string,
    from: Date,
    to: Date,
  ): Promise<number>;
}
