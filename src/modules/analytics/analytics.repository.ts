import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import type { ProductMetrics } from './helper.js';

export const ANALYTICS_QUERY = Symbol('ANALYTICS_QUERY');

export interface AnalyticsQueryPort {
  metrics(churchId: string): Promise<ProductMetrics>;
  sermonsCreatedBetween(
    churchId: string,
    from: Date,
    to: Date,
  ): Promise<number>;
}

@Injectable()
export class PrismaAnalyticsQuery implements AnalyticsQueryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async metrics(churchId: string): Promise<ProductMetrics> {
    const db = this.prisma.db;
    // Three grouped queries instead of one count per metric.
    const [sermons, content, generationFailures] = await Promise.all([
      db.sermon.groupBy({
        by: ['status'],
        where: { churchId },
        _count: { _all: true },
      }),
      db.contentItem.groupBy({
        by: ['status'],
        where: { churchId },
        _count: { _all: true },
      }),
      db.generationJob.count({ where: { churchId, status: 'FAILED' } }),
    ]);
    const sermonCount = (statuses?: string[]) =>
      sermons
        .filter((row) =>
          statuses ? statuses.includes(row.status) : row.status !== 'ARCHIVED',
        )
        .reduce((sum, row) => sum + row._count._all, 0);
    const contentCount = (statuses?: string[]) =>
      content
        .filter((row) =>
          statuses ? statuses.includes(row.status) : row.status !== 'ARCHIVED',
        )
        .reduce((sum, row) => sum + row._count._all, 0);
    return {
      sermonsUploaded: sermonCount(),
      sermonsProcessed: sermonCount(['READY']),
      contentGenerated: contentCount(),
      // Approved = currently approved or further along (scheduled/published).
      contentApproved: contentCount(['APPROVED', 'SCHEDULED', 'PUBLISHED']),
      contentScheduled: contentCount(['SCHEDULED']),
      contentPublished: contentCount(['PUBLISHED']),
      processingFailures: sermonCount(['FAILED']),
      generationFailures,
    };
  }

  sermonsCreatedBetween(
    churchId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    return this.prisma.db.sermon.count({
      where: {
        churchId,
        status: { not: 'ARCHIVED' },
        createdAt: { gte: from, lt: to },
      },
    });
  }
}
