import { Inject, Injectable } from '@nestjs/common';
import type {
  Prisma,
  SocialConnection as ConnectionRow,
  SocialPost as PostRow,
  SocialPublication as PublicationRow,
} from '../../../../generated/prisma/client.js';
import { newId } from '../../../../shared/domain/id.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../../../shared/domain/pagination.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  DueTarget,
  SocialAuditEntry,
  SocialAuditLogPort,
  SocialConnectionRepositoryPort,
  SocialPostFilter,
  SocialPostRepositoryPort,
} from '../../application/ports/out/social-repositories.port.js';
import type { SocialConnection } from '../../domain/social-connection.js';
import type { SocialErrorCode } from '../../domain/social-errors.js';
import type {
  SocialPlatform,
  SocialProviderId,
} from '../../domain/social-platform.js';
import type {
  PublicationStatus,
  SocialPost,
  SocialPostAggregate,
  SocialPostStatus,
  SocialPublication,
} from '../../domain/social-post.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const undef = <T>(value: T | null): T | undefined => value ?? undefined;

const toConnection = (row: ConnectionRow): SocialConnection => ({
  id: row.id,
  churchId: row.churchId,
  platform: row.platform as SocialPlatform,
  provider: row.provider as SocialProviderId,
  providerAccountId: row.providerAccountId,
  accountName: row.accountName,
  avatarUrl: undef(row.avatarUrl),
  encryptedAccessToken: row.encryptedAccessToken,
  encryptedRefreshToken: undef(row.encryptedRefreshToken),
  tokenExpiresAt: undef(row.tokenExpiresAt),
  scopes: row.scopes,
  status: row.status as SocialConnection['status'],
  metadata: row.metadata as Record<string, unknown>,
  connectedByUserId: undef(row.connectedByUserId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class PrismaSocialConnectionRepository implements SocialConnectionRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(churchId: string): Promise<SocialConnection[]> {
    const rows = await this.prisma.db.socialConnection.findMany({
      where: { churchId },
      orderBy: [{ platform: 'asc' }, { accountName: 'asc' }],
    });
    return rows.map(toConnection);
  }

  async findById(
    churchId: string,
    id: string,
  ): Promise<SocialConnection | null> {
    const row = await this.prisma.db.socialConnection.findFirst({
      where: { id, churchId },
    });
    return row ? toConnection(row) : null;
  }

  async findByIds(
    churchId: string,
    ids: string[],
  ): Promise<SocialConnection[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.db.socialConnection.findMany({
      where: { churchId, id: { in: ids } },
    });
    return rows.map(toConnection);
  }

  async findByAccount(
    churchId: string,
    platform: SocialPlatform,
    providerAccountId: string,
  ): Promise<SocialConnection | null> {
    const row = await this.prisma.db.socialConnection.findFirst({
      where: { churchId, platform, providerAccountId },
    });
    return row ? toConnection(row) : null;
  }

  async save(connection: SocialConnection): Promise<void> {
    const { id, churchId, createdAt: _c, updatedAt: _u, ...rest } = connection;
    const data = {
      ...rest,
      avatarUrl: rest.avatarUrl ?? null,
      encryptedRefreshToken: rest.encryptedRefreshToken ?? null,
      tokenExpiresAt: rest.tokenExpiresAt ?? null,
      connectedByUserId: rest.connectedByUserId ?? null,
      metadata: json(rest.metadata),
    };
    await this.prisma.db.socialConnection.upsert({
      where: { id },
      create: { id, churchId, ...data },
      // churchId in the filter of the follow-up guard below keeps writes inside the tenant.
      update: data,
    });
  }

  async countConnectedByGrant(
    churchId: string,
    grantId: string,
    excludingId: string,
  ): Promise<number> {
    return this.prisma.db.socialConnection.count({
      where: {
        churchId,
        status: 'connected',
        id: { not: excludingId },
        metadata: { path: ['grantId'], equals: grantId },
      },
    });
  }

  async findExpiring(
    before: Date,
    limit: number,
    refreshable: boolean,
  ): Promise<SocialConnection[]> {
    const rows = await this.prisma.db.socialConnection.findMany({
      where: {
        status: 'connected',
        tokenExpiresAt: { lt: before },
        encryptedRefreshToken: refreshable ? { not: null } : null,
      },
      orderBy: { tokenExpiresAt: 'asc' },
      take: limit,
    });
    return rows.map(toConnection);
  }
}

const toPost = (row: PostRow): SocialPost => ({
  id: row.id,
  churchId: row.churchId,
  contentId: row.contentItemId,
  caption: row.caption,
  title: undef(row.title),
  mediaAssetIds: row.mediaAssetIds,
  thumbnailAssetId: undef(row.thumbnailAssetId),
  scheduledAt: undef(row.scheduledAt),
  timezone: undef(row.timezone),
  status: row.status as SocialPostStatus,
  createdByUserId: undef(row.createdByUserId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toPublication = (row: PublicationRow): SocialPublication => ({
  id: row.id,
  churchId: row.churchId,
  socialPostId: row.socialPostId,
  connectionId: row.connectionId,
  platform: row.platform as SocialPlatform,
  status: row.status as PublicationStatus,
  providerPostId: undef(row.providerPostId),
  providerRef: undef(row.providerRef),
  permalink: undef(row.permalink),
  attemptCount: row.attemptCount,
  pollCount: row.pollCount,
  lastErrorCode: undef(row.lastErrorCode) as SocialErrorCode | undefined,
  lastErrorMessage: undef(row.lastErrorMessage),
  outcomeUnknown: row.outcomeUnknown,
  settings: row.settings as Record<string, unknown>,
  providerMetadata: row.providerMetadata as Record<string, unknown>,
  metrics: undef(row.metrics) as Record<string, number> | undefined,
  metricsUpdatedAt: undef(row.metricsUpdatedAt),
  publishedAt: undef(row.publishedAt),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const publicationData = (publication: SocialPublication) => ({
  id: publication.id,
  churchId: publication.churchId,
  socialPostId: publication.socialPostId,
  connectionId: publication.connectionId,
  platform: publication.platform,
  status: publication.status,
  attemptCount: publication.attemptCount,
  pollCount: publication.pollCount,
  outcomeUnknown: publication.outcomeUnknown,
  settings: json(publication.settings),
  providerMetadata: json(publication.providerMetadata),
});

const postData = (post: SocialPost) => ({
  contentItemId: post.contentId,
  caption: post.caption,
  title: post.title ?? null,
  mediaAssetIds: post.mediaAssetIds,
  thumbnailAssetId: post.thumbnailAssetId ?? null,
  scheduledAt: post.scheduledAt ?? null,
  timezone: post.timezone ?? null,
  status: post.status,
});

@Injectable()
export class PrismaSocialPostRepository implements SocialPostRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(aggregate: SocialPostAggregate): Promise<void> {
    const { post, publications } = aggregate;
    await this.prisma.db.socialPost.create({
      data: {
        id: post.id,
        churchId: post.churchId,
        createdByUserId: post.createdByUserId ?? null,
        ...postData(post),
        publications: {
          create: publications.map(
            ({ churchId: _c, socialPostId: _p, ...publication }) => ({
              ...publicationData({
                ...publication,
                churchId: post.churchId,
                socialPostId: post.id,
              }),
              churchId: undefined,
              socialPostId: undefined,
              church: { connect: { id: post.churchId } },
              connection: { connect: { id: publication.connectionId } },
              connectionId: undefined,
            }),
          ),
        },
      },
    });
  }

  async find(
    churchId: string,
    id: string,
  ): Promise<SocialPostAggregate | null> {
    const row = await this.prisma.db.socialPost.findFirst({
      where: { id, churchId },
      include: {
        publications: { where: { churchId }, orderBy: { createdAt: 'asc' } },
      },
    });
    return row
      ? { post: toPost(row), publications: row.publications.map(toPublication) }
      : null;
  }

  async list(
    churchId: string,
    filter: SocialPostFilter,
    page: PageRequest,
  ): Promise<Page<SocialPostAggregate>> {
    const where = {
      churchId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.contentId ? { contentItemId: filter.contentId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.socialPost.findMany({
        where,
        include: {
          publications: { where: { churchId }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page),
        take: page.pageSize,
      }),
      this.prisma.db.socialPost.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        post: toPost(row),
        publications: row.publications.map(toPublication),
      })),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async updatePost(post: SocialPost): Promise<void> {
    await this.prisma.db.socialPost.updateMany({
      where: { id: post.id, churchId: post.churchId },
      data: postData(post),
    });
  }

  async replacePublications(
    churchId: string,
    socialPostId: string,
    publications: SocialPublication[],
  ): Promise<void> {
    await this.prisma.db.socialPublication.deleteMany({
      where: { churchId, socialPostId },
    });
    if (publications.length > 0)
      await this.prisma.db.socialPublication.createMany({
        data: publications.map((publication) =>
          publicationData({ ...publication, churchId, socialPostId }),
        ),
      });
  }

  async delete(churchId: string, id: string): Promise<void> {
    await this.prisma.db.socialPost.deleteMany({ where: { id, churchId } });
  }

  async findPublication(
    churchId: string,
    id: string,
  ): Promise<SocialPublication | null> {
    const row = await this.prisma.db.socialPublication.findFirst({
      where: { id, churchId },
    });
    return row ? toPublication(row) : null;
  }

  async transitionPublication(
    churchId: string,
    id: string,
    from: readonly PublicationStatus[],
    patch: Parameters<SocialPostRepositoryPort['transitionPublication']>[3],
  ): Promise<boolean> {
    const { incrementAttempt, metrics, providerMetadata, settings, ...fields } =
      patch;
    const data: Prisma.SocialPublicationUpdateManyMutationInput = {};
    for (const [key, value] of Object.entries(fields))
      (data as Record<string, unknown>)[key] = value ?? null;
    if (providerMetadata !== undefined)
      data.providerMetadata = json(providerMetadata);
    if (settings !== undefined) data.settings = json(settings);
    if (metrics !== undefined) data.metrics = json(metrics);
    if (incrementAttempt) data.attemptCount = { increment: 1 };
    const result = await this.prisma.db.socialPublication.updateMany({
      where: { id, churchId, status: { in: [...from] } },
      data,
    });
    return result.count === 1;
  }

  async claimDue(now: Date, limit: number): Promise<DueTarget[]> {
    // Columns are timestamp-without-time-zone holding UTC, like the rest of the schema.
    const rows = await this.prisma.db.$queryRaw<
      Array<{
        id: string;
        church_id: string;
        social_post_id: string;
        connection_id: string;
      }>
    >`
      UPDATE "social_publications" AS p SET "status" = 'queued', "updated_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE p."id" IN (
        SELECT sp."id" FROM "social_publications" sp
        JOIN "social_posts" s ON s."id" = sp."social_post_id"
        WHERE sp."status" = 'scheduled' AND s."scheduled_at" <= ${now}
        ORDER BY s."scheduled_at"
        LIMIT ${limit}
        FOR UPDATE OF sp SKIP LOCKED
      )
      RETURNING p."id", p."church_id", p."social_post_id", p."connection_id"`;
    return rows.map((row) => ({
      publicationId: row.id,
      churchId: row.church_id,
      socialPostId: row.social_post_id,
      connectionId: row.connection_id,
    }));
  }

  async findStale(
    status: PublicationStatus,
    olderThan: Date,
    limit: number,
  ): Promise<SocialPublication[]> {
    const rows = await this.prisma.db.socialPublication.findMany({
      where: { status, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(toPublication);
  }

  async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.db.socialPublication.updateMany({
      where: { id: { in: ids } },
      data: { updatedAt: new Date() },
    });
  }

  async findForMetrics(
    publishedAfter: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<SocialPublication[]> {
    const rows = await this.prisma.db.socialPublication.findMany({
      where: {
        status: 'published',
        publishedAt: { gte: publishedAfter },
        OR: [
          { metricsUpdatedAt: null },
          { metricsUpdatedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
    return rows.map(toPublication);
  }

  async saveMetrics(
    churchId: string,
    id: string,
    metrics: Record<string, number>,
    at: Date,
  ): Promise<void> {
    await this.prisma.db.socialPublication.updateMany({
      where: { id, churchId },
      data: { metrics: json(metrics), metricsUpdatedAt: at },
    });
  }
}

@Injectable()
export class PrismaSocialAuditLog implements SocialAuditLogPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(entry: SocialAuditEntry): Promise<void> {
    await this.prisma.db.socialAuditLog.create({
      data: {
        id: newId(),
        churchId: entry.churchId,
        userId: entry.userId ?? null,
        action: entry.action,
        connectionId: entry.connectionId ?? null,
        socialPostId: entry.socialPostId ?? null,
        publicationId: entry.publicationId ?? null,
        detail: json(entry.detail ?? {}),
      },
    });
  }
}
