import { Inject, Injectable } from '@nestjs/common';
import type {
  ContentItem as ContentRowModel,
  Prisma,
} from '../../../../generated/prisma/client.js';
import { newId } from '../../../../shared/domain/id.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../../../shared/domain/pagination.js';
import { CalendarItem } from '../../domain/calendar-item.entity.js';
import {
  ContentItem,
  type ContentItemProps,
  type ContentVersionRecord,
} from '../../domain/content-item.entity.js';
import type { SourceMetadata } from '../../domain/content-types.js';
import type {
  GenerationGroupRecord,
  GenerationJobRecord,
} from '../../domain/generation-group.js';
import type {
  CalendarRepositoryPort,
  CalendarRow,
  ContentFilter,
  ContentQueryPort,
  ContentRepositoryPort,
  ContentRow,
  GenerationRepositoryPort,
} from '../../application/ports/out/content-repository.port.js';

const EMPTY_SOURCE: Omit<SourceMetadata, 'sermonId'> = {
  transcriptSegmentIds: [],
  scriptureReferenceIds: [],
  startTimeMs: null,
  endTimeMs: null,
  verbatim: false,
};

const toProps = (row: ContentRowModel): ContentItemProps => ({
  ...row,
  sourceMetadata: {
    ...EMPTY_SOURCE,
    sermonId: row.sermonId,
    ...(row.sourceMetadata as Partial<SourceMetadata>),
  },
});

/** Hard caps for endpoints that return arrays without pagination. */
const MAX_VERSIONS_LISTED = 100;
const MAX_CALENDAR_ITEMS = 500;

const VERSION_SELECT = {
  version: true,
  title: true,
  body: true,
  scripture: true,
  source: true,
  aiProvider: true,
  aiModel: true,
  createdAt: true,
} as const;

@Injectable()
export class PrismaContentRepository implements ContentRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(churchId: string, id: string): Promise<ContentItem | null> {
    const row = await this.prisma.db.contentItem.findFirst({
      where: { id, churchId },
    });
    return row ? ContentItem.restore(toProps(row)) : null;
  }

  async save(item: ContentItem): Promise<void> {
    const { id, churchId, sermonId, createdAt, sourceMetadata, ...data } =
      item.snapshot();
    const metadata = sourceMetadata as unknown as Prisma.InputJsonValue;
    await this.prisma.db.contentItem.upsert({
      where: { id },
      create: {
        id,
        churchId,
        sermonId,
        createdAt,
        sourceMetadata: metadata,
        ...data,
      },
      update: { sourceMetadata: metadata, ...data },
    });
    const versions = item.pendingVersions();
    if (versions.length > 0) {
      // Unique (content_item_id, version) rejects a concurrent writer instead of overwriting history.
      await this.prisma.db.contentVersion.createMany({
        data: versions.map((version) => ({
          id: newId(),
          contentItemId: id,
          ...version,
        })),
      });
    }
  }

  async saveMany(items: ContentItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.prisma.db.contentItem.createMany({
      data: items.map((item) => {
        const { sourceMetadata, ...props } = item.snapshot();
        return {
          ...props,
          sourceMetadata: sourceMetadata as unknown as Prisma.InputJsonValue,
        };
      }),
    });
    await this.prisma.db.contentVersion.createMany({
      data: items.flatMap((item) =>
        item.pendingVersions().map((version) => ({
          id: newId(),
          contentItemId: item.id,
          ...version,
        })),
      ),
    });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.contentItem.deleteMany({ where: { id, churchId } });
  }

  async deleteByGenerationJob(
    churchId: string,
    generationJobId: string,
  ): Promise<void> {
    await this.prisma.db.contentItem.deleteMany({
      where: { churchId, generationJobId },
    });
  }

  listVersions(churchId: string, id: string): Promise<ContentVersionRecord[]> {
    return this.prisma.db.contentVersion.findMany({
      where: { contentItemId: id, contentItem: { churchId } },
      orderBy: { version: 'desc' },
      take: MAX_VERSIONS_LISTED,
      select: VERSION_SELECT,
    });
  }

  findVersion(
    churchId: string,
    id: string,
    version: number,
  ): Promise<ContentVersionRecord | null> {
    return this.prisma.db.contentVersion.findFirst({
      where: { contentItemId: id, version, contentItem: { churchId } },
      select: VERSION_SELECT,
    });
  }
}

const ROW_INCLUDE = {
  sermon: { select: { title: true } },
  calendarItem: { select: { id: true } },
} as const;

type RowWithRelations = ContentRowModel & {
  sermon: { title: string };
  calendarItem: { id: string } | null;
};

const toRow = (row: RowWithRelations): ContentRow => {
  const { sermon, calendarItem, ...rest } = row;
  return {
    ...toProps(rest),
    sermonTitle: sermon.title,
    calendarItemId: calendarItem?.id ?? null,
  };
};

@Injectable()
export class PrismaContentQuery implements ContentQueryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    churchId: string,
    filter: ContentFilter,
    page: PageRequest,
  ): Promise<Page<ContentRow>> {
    const where: Prisma.ContentItemWhereInput = {
      churchId,
      ...(filter.status
        ? { status: filter.status }
        : { status: { not: 'ARCHIVED' } }),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.sermonId ? { sermonId: filter.sermonId } : {}),
      ...(filter.scheduled === false ? { calendarItem: { is: null } } : {}),
      ...(filter.scheduled === true ? { calendarItem: { isNot: null } } : {}),
      ...(filter.q
        ? {
            OR: [
              { title: { contains: filter.q, mode: 'insensitive' } },
              { body: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.db.contentItem.count({ where }),
      this.prisma.db.contentItem.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { position: 'asc' }],
        skip: skipFor(page),
        take: page.pageSize,
      }),
    ]);
    return { items: rows.map(toRow), total, ...page };
  }

  async findRows(churchId: string, ids: string[]): Promise<ContentRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.db.contentItem.findMany({
      where: { churchId, id: { in: ids } },
      include: ROW_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, toRow(row)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
}

const CALENDAR_INCLUDE = {
  contentItem: {
    select: {
      id: true,
      type: true,
      title: true,
      status: true,
      sermonId: true,
      sermon: { select: { title: true } },
    },
  },
} as const;

type CalendarWithContent = Prisma.CalendarItemGetPayload<{
  include: typeof CALENDAR_INCLUDE;
}>;

const toCalendarRow = (row: CalendarWithContent): CalendarRow => ({
  id: row.id,
  contentItemId: row.contentItemId,
  scheduledAt: row.scheduledAt,
  status: row.status,
  content: {
    id: row.contentItem.id,
    type: row.contentItem.type,
    title: row.contentItem.title,
    status: row.contentItem.status,
    sermonId: row.contentItem.sermonId,
    sermonTitle: row.contentItem.sermon.title,
  },
});

@Injectable()
export class PrismaCalendarRepository implements CalendarRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(churchId: string, id: string): Promise<CalendarItem | null> {
    const row = await this.prisma.db.calendarItem.findFirst({
      where: { id, churchId },
    });
    return row ? CalendarItem.restore(row) : null;
  }

  async findByContentItem(
    churchId: string,
    contentItemId: string,
  ): Promise<CalendarItem | null> {
    const row = await this.prisma.db.calendarItem.findFirst({
      where: { contentItemId, churchId },
    });
    return row ? CalendarItem.restore(row) : null;
  }

  async save(item: CalendarItem): Promise<void> {
    const { id, churchId, contentItemId, ...data } = item.snapshot();
    await this.prisma.db.calendarItem.upsert({
      where: { id },
      create: { id, churchId, contentItemId, ...data },
      update: data,
    });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.calendarItem.deleteMany({ where: { id, churchId } });
  }

  async findRows(churchId: string, ids: string[]): Promise<CalendarRow[]> {
    const rows = await this.prisma.db.calendarItem.findMany({
      where: { churchId, id: { in: ids } },
      include: CALENDAR_INCLUDE,
    });
    return rows.map(toCalendarRow);
  }

  async listRange(
    churchId: string,
    from: Date,
    to: Date,
  ): Promise<CalendarRow[]> {
    const rows = await this.prisma.db.calendarItem.findMany({
      where: { churchId, scheduledAt: { gte: from, lte: to } },
      include: CALENDAR_INCLUDE,
      orderBy: { scheduledAt: 'asc' },
      take: MAX_CALENDAR_ITEMS,
    });
    return rows.map(toCalendarRow);
  }
}

@Injectable()
export class PrismaGenerationRepository implements GenerationRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async latestGroup(
    churchId: string,
    sermonId: string,
  ): Promise<GenerationGroupRecord | null> {
    return this.prisma.db.generationGroup.findFirst({
      where: { churchId, sermonId },
      orderBy: { createdAt: 'desc' },
      include: { jobs: { orderBy: { createdAt: 'asc' } } },
    });
  }

  findGroup(
    churchId: string,
    sermonId: string,
    groupId: string,
  ): Promise<GenerationGroupRecord | null> {
    return this.prisma.db.generationGroup.findFirst({
      where: { id: groupId, churchId, sermonId },
      include: { jobs: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async createGroup(group: Omit<GenerationGroupRecord, 'jobs'>): Promise<void> {
    await this.prisma.db.generationGroup.create({ data: group });
  }

  async addJobs(jobs: GenerationJobRecord[]): Promise<void> {
    if (jobs.length > 0)
      await this.prisma.db.generationJob.createMany({ data: jobs });
  }

  findJob(
    churchId: string,
    jobId: string,
  ): Promise<GenerationJobRecord | null> {
    return this.prisma.db.generationJob.findFirst({
      where: { id: jobId, churchId },
    });
  }

  async updateJob(job: GenerationJobRecord): Promise<void> {
    await this.prisma.db.generationJob.updateMany({
      where: { id: job.id, churchId: job.churchId },
      data: {
        status: job.status,
        attempts: job.attempts,
        errorMessage: job.errorMessage,
      },
    });
  }

  async failStale(olderThan: Date, errorMessage: string): Promise<number> {
    const result = await this.prisma.db.generationJob.updateMany({
      where: {
        status: { in: ['QUEUED', 'PROCESSING', 'RETRYING'] },
        updatedAt: { lt: olderThan },
      },
      data: { status: 'FAILED', errorMessage },
    });
    return result.count;
  }
}
