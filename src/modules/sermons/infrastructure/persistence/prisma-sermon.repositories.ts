import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import { lagosYearRange } from '../../../../shared/domain/lagos-time.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../../../shared/domain/pagination.js';
import { PROCESSING_STATUSES } from '../../domain/processing.js';
import type { Sermon } from '../../domain/sermon.entity.js';
import type {
  SermonAssetRecord,
  SermonFilter,
  SermonQueryPort,
  SermonRepositoryPort,
  SermonView,
} from '../../application/ports/out/sermon-repository.port.js';
import { toSermon, toSermonData, toSermonView } from './sermon.mapper.js';

@Injectable()
export class PrismaSermonRepository implements SermonRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(churchId: string, id: string): Promise<Sermon | null> {
    const row = await this.prisma.db.sermon.findFirst({
      where: { id, churchId },
    });
    return row ? toSermon(row) : null;
  }

  async insert(sermon: Sermon): Promise<void> {
    await this.prisma.db.sermon.create({
      data: toSermonData(sermon.snapshot()),
    });
  }

  async updateDetails(sermon: Sermon): Promise<boolean> {
    const {
      id,
      churchId,
      title,
      speaker,
      sermonDate,
      series,
      mainScripture,
      tags,
    } = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: { id, churchId },
      data: { title, speaker, sermonDate, series, mainScripture, tags },
    });
    return result.count === 1;
  }

  async updateProcessing(sermon: Sermon): Promise<boolean> {
    const props = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: {
        id: props.id,
        churchId: props.churchId,
        processingAttempts: props.processingAttempts,
        status: { in: PROCESSING_STATUSES },
      },
      data: {
        status: props.status,
        processingStage: props.processingStage,
        failedStage: props.failedStage,
        errorMessage: props.errorMessage,
        canRetry: props.canRetry,
        summary: props.summary,
        mainTheme: props.mainTheme,
        themes: props.themes,
        scriptures: props.scriptures,
        durationMs: props.durationMs,
        readyAt: props.readyAt,
      },
    });
    return result.count === 1;
  }

  async updateForRetry(sermon: Sermon): Promise<boolean> {
    const props = sermon.snapshot();
    const result = await this.prisma.db.sermon.updateMany({
      where: {
        id: props.id,
        churchId: props.churchId,
        status: 'FAILED',
        processingAttempts: props.processingAttempts - 1,
      },
      data: {
        status: props.status,
        processingStage: props.processingStage,
        failedStage: props.failedStage,
        errorMessage: props.errorMessage,
        canRetry: props.canRetry,
        processingAttempts: props.processingAttempts,
      },
    });
    return result.count === 1;
  }

  async addAsset(asset: SermonAssetRecord): Promise<void> {
    await this.prisma.db.sermonAsset.create({
      data: { ...asset, sizeBytes: BigInt(asset.sizeBytes) },
    });
  }

  async findAssets(
    churchId: string,
    sermonId: string,
  ): Promise<SermonAssetRecord[]> {
    const rows = await this.prisma.db.sermonAsset.findMany({
      where: { churchId, sermonId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  async findExpiredAssets(
    now: Date,
    limit: number,
  ): Promise<SermonAssetRecord[]> {
    const rows = await this.prisma.db.sermonAsset.findMany({
      where: { deletedAt: null, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  async markAssetDeleted(
    churchId: string,
    id: string,
    at: Date,
  ): Promise<void> {
    await this.prisma.db.sermonAsset.updateMany({
      where: { id, churchId, deletedAt: null },
      data: { deletedAt: at },
    });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.sermon.deleteMany({ where: { id, churchId } });
  }

  async findStuckProcessing(olderThan: Date, limit: number): Promise<Sermon[]> {
    const rows = await this.prisma.db.sermon.findMany({
      where: {
        status: { in: PROCESSING_STATUSES },
        updatedAt: { lt: olderThan },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(toSermon);
  }
}

const insensitive = (value: string) => ({
  equals: value,
  mode: 'insensitive' as const,
});

export function sermonWhere(
  churchId: string,
  filter: SermonFilter,
): Prisma.SermonWhereInput {
  const and: Prisma.SermonWhereInput[] = [{ churchId }];
  if (filter.statuses?.length) and.push({ status: { in: filter.statuses } });
  if (filter.q) {
    const contains = { contains: filter.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { speaker: contains },
        { series: contains },
        { mainScripture: contains },
      ],
    });
  }
  if (filter.speaker) and.push({ speaker: insensitive(filter.speaker) });
  if (filter.series) and.push({ series: insensitive(filter.series) });
  if (filter.scripture)
    and.push({
      OR: [
        { scriptures: { has: filter.scripture } },
        { mainScripture: insensitive(filter.scripture) },
      ],
    });
  if (filter.theme) and.push({ themes: { has: filter.theme } });
  if (filter.tag) and.push({ tags: { has: filter.tag.toLowerCase() } });
  if (filter.year) {
    const { start, end } = lagosYearRange(filter.year);
    and.push({ sermonDate: { gte: start, lt: end } });
  }
  return { AND: and };
}

const ORDER: Prisma.SermonOrderByWithRelationInput[] = [
  { sermonDate: 'desc' },
  { createdAt: 'desc' },
];

@Injectable()
export class PrismaSermonQuery implements SermonQueryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    churchId: string,
    filter: SermonFilter,
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    const where = sermonWhere(churchId, filter);
    const [total, rows] = await Promise.all([
      this.prisma.db.sermon.count({ where }),
      this.prisma.db.sermon.findMany({
        where,
        orderBy: ORDER,
        skip: skipFor(page),
        take: page.pageSize,
      }),
    ]);
    const counts = await this.contentCounts(
      churchId,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toSermonView(row, counts.get(row.id) ?? 0)),
      total,
      ...page,
    };
  }

  async findView(churchId: string, id: string): Promise<SermonView | null> {
    const [view] = await this.findViews(churchId, [id]);
    return view ?? null;
  }

  async findViews(churchId: string, ids: string[]): Promise<SermonView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.db.sermon.findMany({
      where: { churchId, id: { in: ids } },
    });
    const counts = await this.contentCounts(
      churchId,
      rows.map((row) => row.id),
    );
    const byId = new Map(
      rows.map((row) => [row.id, toSermonView(row, counts.get(row.id) ?? 0)]),
    );
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async matchingIds(churchId: string, filter: SermonFilter): Promise<string[]> {
    const rows = await this.prisma.db.sermon.findMany({
      where: sermonWhere(churchId, filter),
      select: { id: true },
      take: 5000,
    });
    return rows.map((row) => row.id);
  }

  async latest(churchId: string): Promise<SermonView | null> {
    const row = await this.prisma.db.sermon.findFirst({
      where: { churchId, status: { not: 'ARCHIVED' } },
      orderBy: ORDER,
    });
    if (!row) return null;
    const counts = await this.contentCounts(churchId, [row.id]);
    return toSermonView(row, counts.get(row.id) ?? 0);
  }

  /** One grouped query for the whole page (no N+1). */
  private async contentCounts(
    churchId: string,
    sermonIds: string[],
  ): Promise<Map<string, number>> {
    if (sermonIds.length === 0) return new Map();
    const groups = await this.prisma.db.contentItem.groupBy({
      by: ['sermonId'],
      where: {
        churchId,
        sermonId: { in: sermonIds },
        status: { not: 'ARCHIVED' },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.sermonId, group._count._all]));
  }
}
