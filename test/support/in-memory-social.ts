import type {
  BrandProfileRepositoryPort,
  MediaAssetRepositoryPort,
} from '../../src/modules/brand/brand.repository.js';
import type {
  BrandProfile,
  MediaAsset,
  MediaTechnicalMetadata,
} from '../../src/modules/brand/helper.js';
import type {
  DueTarget,
  SocialAuditEntry,
  SocialAuditLogPort,
  SocialConnectionRepositoryPort,
  SocialPostFilter,
  SocialPostRepositoryPort,
} from '../../src/modules/social/social.repository.js';
import {
  grantIdOf,
  type SocialConnection,
} from '../../src/modules/social/helper.js';
import type { SocialPlatform } from '../../src/modules/social/helper.js';
import type {
  PublicationStatus,
  SocialPost,
  SocialPostAggregate,
  SocialPublication,
} from '../../src/modules/social/helper.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../src/shared/domain/pagination.js';
import type { InMemoryDb, TestClock } from './in-memory-db.js';

const clone = <T>(value: T): T => structuredClone(value);
const values = <T>(map: Map<string, T>): T[] => [...map.values()];

export class InMemoryBrandProfileRepository implements BrandProfileRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async find(churchId: string) {
    const row = this.db.brandProfiles.get(churchId);
    return row ? clone(row) : null;
  }

  async save(profile: BrandProfile) {
    const existing = this.db.brandProfiles.get(profile.churchId);
    this.db.brandProfiles.set(
      profile.churchId,
      clone({ ...profile, id: existing?.id ?? profile.id }),
    );
  }
}

export class InMemoryMediaAssetRepository implements MediaAssetRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  private own(churchId: string) {
    return values(this.db.mediaAssets).filter(
      (asset) => asset.churchId === churchId,
    );
  }

  async createMany(assets: MediaAsset[]) {
    for (const asset of assets) {
      if (
        values(this.db.mediaAssets).some(
          (existing) => existing.objectKey === asset.objectKey,
        )
      )
        throw new Error('Unique violation: object_key');
      this.db.mediaAssets.set(asset.id, clone(asset));
    }
  }

  async findById(churchId: string, id: string) {
    const row = this.db.mediaAssets.get(id);
    return row && row.churchId === churchId ? clone(row) : null;
  }

  async findByIds(churchId: string, ids: string[]) {
    return this.own(churchId)
      .filter((asset) => ids.includes(asset.id))
      .map(clone);
  }

  async listBrandLogos(churchId: string, limit: number) {
    return this.own(churchId)
      .filter((asset) => asset.kind === 'BRAND_LOGO')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async listByContentIds(
    churchId: string,
    contentItemIds: string[],
    limit: number,
  ) {
    return this.own(churchId)
      .filter(
        (asset) =>
          asset.contentItemId !== null &&
          contentItemIds.includes(asset.contentItemId),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.position - b.position,
      )
      .slice(0, limit)
      .map(clone);
  }

  async listByContent(churchId: string, contentItemId: string, limit: number) {
    return this.own(churchId)
      .filter((asset) => asset.contentItemId === contentItemId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.position - b.position,
      )
      .slice(0, limit)
      .map(clone);
  }

  async listByRenderGroup(churchId: string, renderGroupId: string) {
    return this.own(churchId)
      .filter((asset) => asset.renderGroupId === renderGroupId)
      .sort((a, b) => a.position - b.position)
      .map(clone);
  }

  async markReady(
    churchId: string,
    id: string,
    technical: MediaTechnicalMetadata,
  ) {
    const row = this.db.mediaAssets.get(id);
    if (!row || row.churchId !== churchId || row.status !== 'PENDING')
      return false;
    Object.assign(row, technical, {
      status: 'READY',
      errorMessage: null,
      updatedAt: this.clock.now(),
    });
    return true;
  }

  async markFailed(churchId: string, ids: string[], message: string) {
    for (const id of ids) {
      const row = this.db.mediaAssets.get(id);
      if (row && row.churchId === churchId && row.status === 'PENDING')
        Object.assign(row, {
          status: 'FAILED',
          errorMessage: message,
          updatedAt: this.clock.now(),
        });
    }
  }

  async delete(churchId: string, id: string) {
    if (this.db.mediaAssets.get(id)?.churchId === churchId)
      this.db.mediaAssets.delete(id);
  }

  async failStaleRenders(olderThan: Date, message: string) {
    let count = 0;
    for (const row of this.db.mediaAssets.values())
      if (
        row.status === 'PENDING' &&
        row.kind !== 'BRAND_LOGO' &&
        row.updatedAt < olderThan
      ) {
        Object.assign(row, { status: 'FAILED', errorMessage: message });
        count++;
      }
    return count;
  }

  async findStaleUploads(olderThan: Date, limit: number) {
    return values(this.db.mediaAssets)
      .filter(
        (row) =>
          row.status === 'PENDING' &&
          row.kind === 'BRAND_LOGO' &&
          row.createdAt < olderThan,
      )
      .slice(0, limit)
      .map(clone);
  }
}

export class InMemorySocialConnectionRepository implements SocialConnectionRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  private own(churchId: string) {
    return values(this.db.socialConnections).filter(
      (row) => row.churchId === churchId,
    );
  }

  async list(churchId: string) {
    return this.own(churchId).map(clone);
  }

  async findById(churchId: string, id: string) {
    const row = this.db.socialConnections.get(id);
    return row && row.churchId === churchId ? clone(row) : null;
  }

  async findByIds(churchId: string, ids: string[]) {
    return this.own(churchId)
      .filter((row) => ids.includes(row.id))
      .map(clone);
  }

  async findByAccount(
    churchId: string,
    platform: SocialPlatform,
    providerAccountId: string,
  ) {
    const row = this.own(churchId).find(
      (connection) =>
        connection.platform === platform &&
        connection.providerAccountId === providerAccountId,
    );
    return row ? clone(row) : null;
  }

  async save(connection: SocialConnection) {
    const existing = this.db.socialConnections.get(connection.id);
    if (existing && existing.churchId !== connection.churchId)
      throw new Error('Cross-church write');
    const duplicate = this.own(connection.churchId).find(
      (row) =>
        row.id !== connection.id &&
        row.platform === connection.platform &&
        row.providerAccountId === connection.providerAccountId,
    );
    if (duplicate) throw new Error('Unique violation: church/platform/account');
    this.db.socialConnections.set(connection.id, clone(connection));
  }

  async countConnectedByGrant(
    churchId: string,
    grantId: string,
    excludingId: string,
  ) {
    return this.own(churchId).filter(
      (row) =>
        row.id !== excludingId &&
        row.status === 'connected' &&
        grantIdOf(row) === grantId,
    ).length;
  }

  async findExpiring(before: Date, limit: number, refreshable: boolean) {
    return values(this.db.socialConnections)
      .filter(
        (row) =>
          row.status === 'connected' &&
          row.tokenExpiresAt !== undefined &&
          row.tokenExpiresAt < before &&
          Boolean(row.encryptedRefreshToken) === refreshable,
      )
      .slice(0, limit)
      .map(clone);
  }
}

export class InMemorySocialPostRepository implements SocialPostRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  private aggregate(post: SocialPost): SocialPostAggregate {
    return {
      post: clone(post),
      publications: values(this.db.socialPublications)
        .filter(
          (publication) =>
            publication.socialPostId === post.id &&
            publication.churchId === post.churchId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(clone),
    };
  }

  async create(aggregate: SocialPostAggregate) {
    this.db.socialPosts.set(aggregate.post.id, clone(aggregate.post));
    for (const publication of aggregate.publications)
      this.insertPublication(publication);
  }

  private insertPublication(publication: SocialPublication) {
    if (
      values(this.db.socialPublications).some(
        (row) =>
          row.socialPostId === publication.socialPostId &&
          row.connectionId === publication.connectionId,
      )
    )
      throw new Error('Unique violation: post/connection');
    this.db.socialPublications.set(publication.id, clone(publication));
  }

  async find(churchId: string, id: string) {
    const post = this.db.socialPosts.get(id);
    return post && post.churchId === churchId ? this.aggregate(post) : null;
  }

  async list(
    churchId: string,
    filter: SocialPostFilter,
    page: PageRequest,
  ): Promise<Page<SocialPostAggregate>> {
    const rows = values(this.db.socialPosts)
      .filter(
        (post) =>
          post.churchId === churchId &&
          (!filter.status || post.status === filter.status) &&
          (!filter.contentId || post.contentId === filter.contentId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: rows
        .slice(skipFor(page), skipFor(page) + page.pageSize)
        .map((post) => this.aggregate(post)),
      total: rows.length,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async updatePost(post: SocialPost) {
    const existing = this.db.socialPosts.get(post.id);
    if (existing && existing.churchId === post.churchId)
      this.db.socialPosts.set(
        post.id,
        clone({ ...post, updatedAt: this.clock.now() }),
      );
  }

  async replacePublications(
    churchId: string,
    socialPostId: string,
    publications: SocialPublication[],
  ) {
    for (const [id, row] of this.db.socialPublications)
      if (row.churchId === churchId && row.socialPostId === socialPostId)
        this.db.socialPublications.delete(id);
    for (const publication of publications)
      this.insertPublication({ ...publication, churchId, socialPostId });
  }

  async delete(churchId: string, id: string) {
    if (this.db.socialPosts.get(id)?.churchId !== churchId) return;
    this.db.socialPosts.delete(id);
    for (const [key, row] of this.db.socialPublications)
      if (row.socialPostId === id) this.db.socialPublications.delete(key);
  }

  async findPublication(churchId: string, id: string) {
    const row = this.db.socialPublications.get(id);
    return row && row.churchId === churchId ? clone(row) : null;
  }

  async transitionPublication(
    churchId: string,
    id: string,
    from: readonly PublicationStatus[],
    patch: Parameters<SocialPostRepositoryPort['transitionPublication']>[3],
  ) {
    const row = this.db.socialPublications.get(id);
    if (!row || row.churchId !== churchId || !from.includes(row.status))
      return false;
    const { incrementAttempt, ...fields } = patch;
    Object.assign(row, clone(fields), { updatedAt: this.clock.now() });
    if (incrementAttempt) row.attemptCount++;
    return true;
  }

  async claimDue(now: Date, limit: number): Promise<DueTarget[]> {
    const due = values(this.db.socialPublications)
      .filter((row) => {
        const post = this.db.socialPosts.get(row.socialPostId);
        return (
          row.status === 'scheduled' &&
          post?.scheduledAt !== undefined &&
          post.scheduledAt <= now
        );
      })
      .slice(0, limit);
    for (const row of due)
      Object.assign(row, { status: 'queued', updatedAt: this.clock.now() });
    return due.map((row) => ({
      churchId: row.churchId,
      socialPostId: row.socialPostId,
      publicationId: row.id,
      connectionId: row.connectionId,
    }));
  }

  async findStale(status: PublicationStatus, olderThan: Date, limit: number) {
    return values(this.db.socialPublications)
      .filter((row) => row.status === status && row.updatedAt < olderThan)
      .slice(0, limit)
      .map(clone);
  }

  async touch(ids: string[]) {
    for (const id of ids) {
      const row = this.db.socialPublications.get(id);
      if (row) row.updatedAt = this.clock.now();
    }
  }

  async findForMetrics(publishedAfter: Date, staleBefore: Date, limit: number) {
    return values(this.db.socialPublications)
      .filter(
        (row) =>
          row.status === 'published' &&
          row.publishedAt !== undefined &&
          row.publishedAt >= publishedAfter &&
          (!row.metricsUpdatedAt || row.metricsUpdatedAt < staleBefore),
      )
      .slice(0, limit)
      .map(clone);
  }

  async saveMetrics(
    churchId: string,
    id: string,
    metrics: Record<string, number>,
    at: Date,
  ) {
    const row = this.db.socialPublications.get(id);
    if (row && row.churchId === churchId)
      Object.assign(row, { metrics: clone(metrics), metricsUpdatedAt: at });
  }
}

export class InMemorySocialAuditLog implements SocialAuditLogPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async record(entry: SocialAuditEntry) {
    this.db.socialAudit.push({ ...clone(entry), createdAt: this.clock.now() });
  }
}
