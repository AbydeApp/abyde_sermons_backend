import { Inject, Injectable } from '@nestjs/common';
import type { ContentType } from '../../../content/domain/content-types.js';
import {
  isUniqueViolation,
  PrismaService,
} from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  DueItem,
  PublishAttemptRecord,
  PublishingRepositoryPort,
} from '../../application/ports/out/publishing.ports.js';

@Injectable()
export class PrismaPublishingRepository implements PublishingRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async claimDue(
    now: Date,
    types: ContentType[],
    limit: number,
  ): Promise<DueItem[]> {
    if (types.length === 0) return [];
    const rows = await this.prisma.db.$queryRaw<
      Array<{
        id: string;
        church_id: string;
        content_item_id: string;
        scheduled_at: Date;
      }>
    >`
      UPDATE "calendar_items" AS ci SET "status" = 'PUBLISHING', "updated_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE ci."id" IN (
        SELECT c."id" FROM "calendar_items" c
        JOIN "content_items" i ON i."id" = c."content_item_id"
        WHERE c."status" = 'SCHEDULED' AND c."scheduled_at" <= ${now}
          AND i."status" = 'SCHEDULED' AND i."type"::text = ANY(${types}::text[])
        ORDER BY c."scheduled_at"
        LIMIT ${limit}
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING ci."id", ci."church_id", ci."content_item_id", ci."scheduled_at"`;
    return rows.map((row) => ({
      calendarItemId: row.id,
      churchId: row.church_id,
      contentItemId: row.content_item_id,
      scheduledAt: row.scheduled_at,
    }));
  }

  async releaseStale(olderThan: Date): Promise<number> {
    // Only release claims that never started an attempt; started ones are resolved by the publish job itself.
    // Columns are timestamp-without-time-zone holding UTC, so no session-time-zone conversion is applied.
    return this.prisma.db.$executeRaw`
      UPDATE "calendar_items" c SET "status" = 'SCHEDULED', "updated_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE c."status" = 'PUBLISHING' AND c."updated_at" < ${olderThan}
        AND NOT EXISTS (
          SELECT 1 FROM "publish_attempts" a
          WHERE a."idempotency_key" = c."id"::text || ':' || to_char(c."scheduled_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )`;
  }

  async findAttempt(
    idempotencyKey: string,
  ): Promise<PublishAttemptRecord | null> {
    return this.prisma.db.publishAttempt.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        churchId: true,
        contentItemId: true,
        provider: true,
        idempotencyKey: true,
        status: true,
        externalId: true,
        errorMessage: true,
        updatedAt: true,
      },
    });
  }

  async createAttempt(
    attempt: Omit<PublishAttemptRecord, 'updatedAt'>,
  ): Promise<boolean> {
    try {
      await this.prisma.db.publishAttempt.create({ data: attempt });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async reopenAttempt(id: string): Promise<boolean> {
    // Only attempts that definitely did not publish (error_message prefixed "definite:") may be retried.
    const result = await this.prisma.db.publishAttempt.updateMany({
      where: {
        id,
        status: 'FAILED',
        errorMessage: { startsWith: 'definite:' },
      },
      data: { status: 'PENDING', errorMessage: null },
    });
    return result.count === 1;
  }

  async completeAttempt(
    id: string,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED';
      externalId?: string | null;
      errorMessage?: string | null;
      definite?: boolean;
    },
  ): Promise<void> {
    const errorMessage =
      outcome.status === 'FAILED'
        ? `${outcome.definite ? 'definite' : 'uncertain'}: ${outcome.errorMessage ?? ''}`.slice(
            0,
            600,
          )
        : null;
    await this.prisma.db.publishAttempt.updateMany({
      where: { id },
      data: {
        status: outcome.status,
        externalId: outcome.externalId ?? null,
        errorMessage,
      },
    });
  }

  async setCalendarStatus(
    churchId: string,
    calendarItemId: string,
    status: 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
  ): Promise<void> {
    await this.prisma.db.calendarItem.updateMany({
      where: { id: calendarItemId, churchId },
      data: { status },
    });
  }
}
