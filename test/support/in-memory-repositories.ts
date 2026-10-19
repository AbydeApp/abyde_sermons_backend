import type {
  AIUsageEntry,
  AIUsageRecorderPort,
  UsageMeterPort,
  UsageRecord,
  UsageUnit,
} from '../../src/shared/application/ports/usage-meter.port.js';
import { lagosYearRange } from '../../src/shared/domain/lagos-time.js';
import {
  type Page,
  type PageRequest,
  skipFor,
} from '../../src/shared/domain/pagination.js';
import { churchExists, emailTaken } from '../../src/modules/auth/helper.js';
import {
  type AuthRepository,
  type ChurchRecord,
  type EmailVerificationRecord,
  type PasswordResetRecord,
  type SessionRecord,
  type UserRecord,
} from '../../src/modules/auth/auth.repository.js';
import type {
  UploadRecord,
  UploadRepositoryPort,
} from '../../src/modules/uploads/application/ports/out/upload-repository.port.js';
import { PROCESSING_STATUSES } from '../../src/modules/sermons/domain/processing.js';
import {
  Sermon,
  type SermonProps,
} from '../../src/modules/sermons/domain/sermon.entity.js';
import type {
  SermonAssetRecord,
  SermonFilter,
  SermonQueryPort,
  SermonRepositoryPort,
  SermonView,
} from '../../src/modules/sermons/application/ports/out/sermon-repository.port.js';
import type {
  EmbeddingRepositoryPort,
  EmbeddingRow,
  IntelligenceRepositoryPort,
  SegmentMatch,
  TranscriptRepositoryPort,
} from '../../src/modules/sermons/application/ports/out/transcript-repository.port.js';
import type { SegmentDraft } from '../../src/modules/sermons/domain/transcript-segmenter.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../src/modules/sermons/domain/sermon-intelligence.js';
import {
  CalendarItem,
  type CalendarRow,
  ContentItem,
  type ContentItemProps,
  type ContentType,
  type ContentVersionRecord,
  type GenerationGroupRecord,
  type GenerationJobRecord,
} from '../../src/modules/content/helper.js';
import type {
  CalendarRepositoryPort,
  ContentFilter,
  ContentQueryPort,
  ContentRepositoryPort,
  ContentRow,
  GenerationRepositoryPort,
} from '../../src/modules/content/content.repository.js';
import type { UsageQueryPort } from '../../src/modules/usage/application/ports/out/usage-query.port.js';
import type { SubscriptionRecord } from '../../src/modules/billing/domain/subscription.js';
import type { SubscriptionRepositoryPort } from '../../src/modules/billing/application/ports/out/billing.ports.js';
import type {
  IntegrationProvider,
  IntegrationRecord,
} from '../../src/modules/integrations/domain/integration.js';
import type { IntegrationRepositoryPort } from '../../src/modules/integrations/application/ports/out/integration.ports.js';
import type {
  DueItem,
  PublishAttemptRecord,
  PublishingRepositoryPort,
} from '../../src/modules/publishing/application/ports/out/publishing.ports.js';
import type {
  LibraryFacets,
  LibraryFacetsPort,
} from '../../src/modules/library/application/ports/out/library-facets.port.js';
import type {
  AnalyticsQueryPort,
  ProductMetrics,
} from '../../src/modules/analytics/application/ports/out/analytics-query.port.js';
import { lagosYear } from '../../src/shared/domain/lagos-time.js';
import type { InMemoryDb, TestClock } from './in-memory-db.js';

const clone = <T>(value: T): T => structuredClone(value);
const values = <T>(map: Map<string, T>): T[] => [...map.values()];

export class InMemoryAuthRepository implements AuthRepository {
  constructor(private readonly db: InMemoryDb) {}

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = this.db.users.get(id);
    return row ? clone(row) : null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const row = values(this.db.users).find((user) => user.email === email);
    return row ? clone(row) : null;
  }

  async saveUser(user: UserRecord) {
    if (
      values(this.db.users).some(
        (other) => other.email === user.email && other.id !== user.id,
      )
    )
      throw emailTaken();
    this.db.users.set(user.id, clone(user));
  }

  async findChurchById(id: string) {
    const row = this.db.churches.get(id);
    return row ? clone(row) : null;
  }

  async findChurchByUserId(userId: string) {
    const row = values(this.db.churches).find(
      (church) => church.userId === userId,
    );
    return row ? clone(row) : null;
  }

  async findChurchIdByUserId(userId: string) {
    return (
      values(this.db.churches).find((church) => church.userId === userId)?.id ??
      null
    );
  }

  async churchSlugExists(slug: string) {
    return values(this.db.churches).some((church) => church.slug === slug);
  }

  async saveChurch(church: ChurchRecord) {
    if (
      values(this.db.churches).some(
        (other) =>
          other.id !== church.id &&
          (other.userId === church.userId || other.slug === church.slug),
      )
    )
      throw churchExists();
    this.db.churches.set(church.id, clone(church));
  }

  async saveEmailVerification(
    record: Omit<EmailVerificationRecord, 'attempts'>,
  ) {
    this.db.emailVerifications.set(record.userId, { ...record, attempts: 0 });
  }

  async findEmailVerification(userId: string) {
    const row = this.db.emailVerifications.get(userId);
    return row ? clone(row) : null;
  }

  async recordFailedVerification(userId: string) {
    const row = this.db.emailVerifications.get(userId);
    if (!row) return 0;
    row.attempts += 1;
    return row.attempts;
  }

  async deleteEmailVerification(userId: string) {
    this.db.emailVerifications.delete(userId);
  }

  async deleteExpiredEmailVerifications(cutoff: Date) {
    let deleted = 0;
    for (const [id, row] of this.db.emailVerifications)
      if (row.expiresAt < cutoff && this.db.emailVerifications.delete(id))
        deleted++;
    return deleted;
  }

  async createSession(session: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    now: Date;
  }) {
    this.db.sessions.set(session.id, {
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      revokedAt: null,
      lastSeenAt: session.now,
      userAgent: session.userAgent,
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = values(this.db.sessions).find(
      (session) => session.tokenHash === tokenHash,
    );
    return row ? clone(row) : null;
  }

  async rotateSession(
    id: string,
    currentTokenHash: string,
    nextTokenHash: string,
    at: Date,
  ) {
    const row = this.db.sessions.get(id);
    if (!row || row.revokedAt || row.tokenHash !== currentTokenHash)
      return false;
    row.tokenHash = nextTokenHash;
    row.lastSeenAt = at;
    return true;
  }

  async revokeSession(id: string, at: Date) {
    const row = this.db.sessions.get(id);
    if (row && !row.revokedAt) row.revokedAt = at;
  }

  async revokeAllSessionsForUser(
    userId: string,
    at: Date,
    exceptSessionId?: string,
  ) {
    const revoked: string[] = [];
    for (const row of this.db.sessions.values()) {
      if (
        row.userId === userId &&
        !row.revokedAt &&
        row.id !== exceptSessionId
      ) {
        row.revokedAt = at;
        revoked.push(row.id);
      }
    }
    return revoked;
  }

  async deleteExpiredSessions(cutoff: Date) {
    let deleted = 0;
    for (const [id, row] of this.db.sessions)
      if (row.expiresAt < cutoff && this.db.sessions.delete(id)) deleted++;
    return deleted;
  }

  async createPasswordReset(record: Omit<PasswordResetRecord, 'usedAt'>) {
    this.db.passwordResets.set(record.id, { ...record, usedAt: null });
  }

  async findPasswordResetByTokenHash(tokenHash: string) {
    const row = values(this.db.passwordResets).find(
      (reset) => reset.tokenHash === tokenHash,
    );
    return row ? clone(row) : null;
  }

  async consumePasswordReset(id: string, at: Date) {
    const row = this.db.passwordResets.get(id);
    if (!row || row.usedAt) return false;
    row.usedAt = at;
    return true;
  }

  async invalidatePasswordResetsForUser(userId: string, at: Date) {
    for (const row of this.db.passwordResets.values())
      if (row.userId === userId && !row.usedAt) row.usedAt = at;
  }

  async deleteExpiredPasswordResets(cutoff: Date) {
    let deleted = 0;
    for (const [id, row] of this.db.passwordResets)
      if (row.expiresAt < cutoff && this.db.passwordResets.delete(id))
        deleted++;
    return deleted;
  }
}


export class InMemoryUploadRepository implements UploadRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async create(record: UploadRecord) {
    this.db.uploads.set(record.id, clone(record));
  }

  async findByKey(churchId: string, objectKey: string) {
    const row = values(this.db.uploads).find(
      (upload) =>
        upload.churchId === churchId && upload.objectKey === objectKey,
    );
    return row ? clone(row) : null;
  }

  async markConsumed(id: string, at: Date) {
    const row = this.db.uploads.get(id);
    if (!row || row.consumedAt) return false;
    row.consumedAt = at;
    return true;
  }

  async findStaleUnconsumed(olderThan: Date, limit: number) {
    return values(this.db.uploads)
      .filter((upload) => !upload.consumedAt && upload.createdAt < olderThan)
      .slice(0, limit)
      .map(clone);
  }

  async deleteIfUnconsumed(id: string) {
    if (this.db.uploads.get(id)?.consumedAt !== null) return false;
    return this.db.uploads.delete(id);
  }
}

/** Mirrors ON DELETE CASCADE from sermons. */
function cascadeDeleteSermon(db: InMemoryDb, sermonId: string): void {
  db.sermons.delete(sermonId);
  for (const [id, row] of db.assets)
    if (row.sermonId === sermonId) db.assets.delete(id);
  for (const [id, row] of db.transcripts)
    if (row.sermonId === sermonId) db.transcripts.delete(id);
  for (const [id, row] of db.segments)
    if (row.sermonId === sermonId) db.segments.delete(id);
  db.intelligence.delete(sermonId);
  for (const [id, row] of db.scriptureRefs)
    if (row.sermonId === sermonId) db.scriptureRefs.delete(id);
  for (const [id, row] of db.embeddings)
    if (row.sermonId === sermonId) db.embeddings.delete(id);
  for (const [id, row] of db.generationGroups)
    if (row.sermonId === sermonId) db.generationGroups.delete(id);
  for (const [id, row] of db.generationJobs)
    if (row.sermonId === sermonId) db.generationJobs.delete(id);
  for (const [id, row] of db.contentItems)
    if (row.sermonId === sermonId) cascadeDeleteContent(db, id);
}

function cascadeDeleteContent(db: InMemoryDb, contentItemId: string): void {
  db.contentItems.delete(contentItemId);
  db.contentVersions = db.contentVersions.filter(
    (version) => version.contentItemId !== contentItemId,
  );
  for (const [id, row] of db.calendarItems)
    if (row.contentItemId === contentItemId) db.calendarItems.delete(id);
  for (const [id, row] of db.publishAttempts)
    if (row.contentItemId === contentItemId) db.publishAttempts.delete(id);
}

export class InMemorySermonRepository implements SermonRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async findById(churchId: string, id: string) {
    const row = this.db.sermons.get(id);
    if (!row || row.churchId !== churchId) return null;
    const { updatedAt: _updatedAt, ...props } = clone(row);
    return Sermon.restore(props);
  }

  async insert(sermon: Sermon) {
    if (this.db.sermons.has(sermon.id))
      throw new Error('unique violation: sermon');
    this.db.sermons.set(sermon.id, {
      ...clone(sermon.snapshot()),
      updatedAt: this.clock.now(),
    });
  }

  private patch(
    sermon: Sermon,
    guard: (row: SermonProps) => boolean,
    keys: Array<keyof SermonProps>,
  ): boolean {
    const props = sermon.snapshot();
    const row = this.db.sermons.get(props.id);
    if (!row || row.churchId !== props.churchId || !guard(row)) return false;
    const changes = Object.fromEntries(
      keys.map((key) => [key, clone(props[key])]),
    );
    Object.assign(row, changes, { updatedAt: this.clock.now() });
    return true;
  }

  async updateDetails(sermon: Sermon) {
    return this.patch(sermon, () => true, [
      'title',
      'speaker',
      'sermonDate',
      'series',
      'mainScripture',
      'tags',
    ]);
  }

  async updateProcessing(sermon: Sermon) {
    return this.patch(
      sermon,
      (row) =>
        row.processingAttempts === sermon.processingAttempts &&
        PROCESSING_STATUSES.includes(row.status),
      [
        'status',
        'processingStage',
        'failedStage',
        'errorMessage',
        'canRetry',
        'summary',
        'mainTheme',
        'themes',
        'scriptures',
        'durationMs',
        'readyAt',
      ],
    );
  }

  async updateForRetry(sermon: Sermon) {
    return this.patch(
      sermon,
      (row) =>
        row.status === 'FAILED' &&
        row.processingAttempts === sermon.processingAttempts - 1,
      [
        'status',
        'processingStage',
        'failedStage',
        'errorMessage',
        'canRetry',
        'processingAttempts',
      ],
    );
  }

  async addAsset(asset: SermonAssetRecord) {
    this.db.assets.set(asset.id, clone(asset));
  }

  async findAssets(churchId: string, sermonId: string) {
    return values(this.db.assets)
      .filter(
        (asset) => asset.churchId === churchId && asset.sermonId === sermonId,
      )
      .map(clone);
  }

  async findExpiredAssets(now: Date, limit: number) {
    return values(this.db.assets)
      .filter(
        (asset) =>
          asset.deletedAt === null &&
          asset.expiresAt !== null &&
          asset.expiresAt.getTime() <= now.getTime(),
      )
      .sort(
        (a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0),
      )
      .slice(0, limit)
      .map(clone);
  }

  async markAssetDeleted(churchId: string, id: string, at: Date) {
    const asset = this.db.assets.get(id);
    if (asset && asset.churchId === churchId && asset.deletedAt === null)
      asset.deletedAt = new Date(at);
  }

  async delete(churchId: string, id: string) {
    if (this.db.sermons.get(id)?.churchId === churchId)
      cascadeDeleteSermon(this.db, id);
  }

  async findStuckProcessing(olderThan: Date, limit: number) {
    return values(this.db.sermons)
      .filter(
        (row) =>
          PROCESSING_STATUSES.includes(row.status) && row.updatedAt < olderThan,
      )
      .slice(0, limit)
      .map(({ updatedAt: _updatedAt, ...props }) =>
        Sermon.restore(clone(props)),
      );
  }
}

export class InMemorySermonQuery implements SermonQueryPort {
  constructor(private readonly db: InMemoryDb) {}

  private matches(churchId: string, filter: SermonFilter) {
    const eq = (a: string | null, b: string) =>
      a !== null && a.toLowerCase() === b.toLowerCase();
    return values(this.db.sermons).filter((sermon) => {
      if (sermon.churchId !== churchId) return false;
      if (filter.statuses?.length && !filter.statuses.includes(sermon.status))
        return false;
      if (filter.q) {
        const q = filter.q.toLowerCase();
        if (
          ![
            sermon.title,
            sermon.speaker,
            sermon.series ?? '',
            sermon.mainScripture ?? '',
          ].some((field) => field.toLowerCase().includes(q))
        )
          return false;
      }
      if (filter.speaker && !eq(sermon.speaker, filter.speaker)) return false;
      if (filter.series && !eq(sermon.series, filter.series)) return false;
      if (
        filter.scripture &&
        !sermon.scriptures.includes(filter.scripture) &&
        !eq(sermon.mainScripture, filter.scripture)
      )
        return false;
      if (filter.theme && !sermon.themes.includes(filter.theme)) return false;
      if (filter.tag && !sermon.tags.includes(filter.tag.toLowerCase()))
        return false;
      if (filter.year) {
        const { start, end } = lagosYearRange(filter.year);
        if (sermon.sermonDate < start || sermon.sermonDate >= end) return false;
      }
      return true;
    });
  }

  private view(row: SermonView & Record<string, unknown>): SermonView {
    const contentCount = values(this.db.contentItems).filter(
      (item) => item.sermonId === row.id && item.status !== 'ARCHIVED',
    ).length;
    return {
      id: row.id,
      title: row.title,
      speaker: row.speaker,
      sermonDate: row.sermonDate,
      series: row.series,
      mainScripture: row.mainScripture,
      tags: [...row.tags],
      status: row.status,
      processingStage: row.status === 'READY' ? null : row.processingStage,
      summary: row.summary,
      mainTheme: row.mainTheme,
      scriptures: [...row.scriptures],
      themes: [...row.themes],
      contentCount,
      createdAt: row.createdAt,
    };
  }

  private sorted(rows: Array<SermonView & Record<string, unknown>>) {
    return [...rows].sort(
      (a, b) =>
        b.sermonDate.getTime() - a.sermonDate.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async list(
    churchId: string,
    filter: SermonFilter,
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    const rows = this.sorted(this.matches(churchId, filter) as never);
    return {
      items: rows
        .slice(skipFor(page), skipFor(page) + page.pageSize)
        .map((row) => this.view(row)),
      total: rows.length,
      ...page,
    };
  }

  async findView(churchId: string, id: string) {
    const row = this.db.sermons.get(id);
    return row && row.churchId === churchId ? this.view(row as never) : null;
  }

  async findViews(churchId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const row = this.db.sermons.get(id);
      return row && row.churchId === churchId ? [this.view(row as never)] : [];
    });
  }

  async matchingIds(churchId: string, filter: SermonFilter) {
    return this.matches(churchId, filter).map((sermon) => sermon.id);
  }

  async latest(churchId: string) {
    const [row] = this.sorted(
      values(this.db.sermons).filter(
        (sermon) =>
          sermon.churchId === churchId && sermon.status !== 'ARCHIVED',
      ) as never,
    );
    return row ? this.view(row) : null;
  }
}

export class InMemoryTranscriptRepository implements TranscriptRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async saveSourceText(input: {
    id: string;
    churchId: string;
    sermonId: string;
    text: string;
  }) {
    this.db.transcripts.set(input.id, {
      id: input.id,
      churchId: input.churchId,
      sermonId: input.sermonId,
      fullText: input.text,
      language: null,
      provider: 'pasted',
    });
  }

  async findSourceText(churchId: string, sermonId: string) {
    return (
      values(this.db.transcripts).find(
        (t) => t.churchId === churchId && t.sermonId === sermonId,
      )?.fullText ?? null
    );
  }

  async replace(input: {
    churchId: string;
    sermonId: string;
    transcriptId: string;
    fullText: string;
    language: string | null;
    provider: string;
    segments: Array<SegmentDraft & { id: string }>;
  }) {
    for (const [id, row] of this.db.transcripts)
      if (row.sermonId === input.sermonId && row.churchId === input.churchId)
        this.db.transcripts.delete(id);
    for (const [id, row] of this.db.segments)
      if (row.sermonId === input.sermonId && row.churchId === input.churchId)
        this.db.segments.delete(id);
    this.db.transcripts.set(input.transcriptId, {
      id: input.transcriptId,
      churchId: input.churchId,
      sermonId: input.sermonId,
      fullText: input.fullText,
      language: input.language,
      provider: input.provider,
    });
    for (const segment of input.segments) {
      this.db.segments.set(segment.id, {
        ...segment,
        speakerLabel: null,
        churchId: input.churchId,
        sermonId: input.sermonId,
        transcriptId: input.transcriptId,
      });
    }
  }

  async countSegments(churchId: string, sermonId: string) {
    return values(this.db.segments).filter(
      (s) => s.churchId === churchId && s.sermonId === sermonId,
    ).length;
  }

  async listSegments(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]> {
    return values(this.db.segments)
      .filter((s) => s.churchId === churchId && s.sermonId === sermonId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ id, sequence, startTimeMs, endTimeMs, text, speakerLabel }) => ({
        id,
        sequence,
        startTimeMs,
        endTimeMs,
        text,
        speakerLabel,
      }));
  }

  async listSegmentsWithWords(
    churchId: string,
    sermonId: string,
  ): Promise<TranscriptSegmentRecord[]> {
    return values(this.db.segments)
      .filter((s) => s.churchId === churchId && s.sermonId === sermonId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        ({ id, sequence, startTimeMs, endTimeMs, text, speakerLabel, words }) =>
          structuredClone({
            id,
            sequence,
            startTimeMs,
            endTimeMs,
            text,
            speakerLabel,
            ...(words ? { words } : {}),
          }),
      );
  }

  async findSegments(churchId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const s = this.db.segments.get(id);
      return s && s.churchId === churchId
        ? [
            {
              id: s.id,
              sequence: s.sequence,
              startTimeMs: s.startTimeMs,
              endTimeMs: s.endTimeMs,
              text: s.text,
              speakerLabel: s.speakerLabel,
              sermonId: s.sermonId,
            },
          ]
        : [];
    });
  }
}

export class InMemoryIntelligenceRepository implements IntelligenceRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async upsert(input: {
    churchId: string;
    sermonId: string;
    data: SermonIntelligence;
    aiProvider: string;
    aiModel: string;
  }) {
    this.db.intelligence.set(
      input.sermonId,
      clone({
        churchId: input.churchId,
        sermonId: input.sermonId,
        data: input.data,
        aiProvider: input.aiProvider,
        aiModel: input.aiModel,
      }),
    );
  }

  async find(churchId: string, sermonId: string) {
    const row = this.db.intelligence.get(sermonId);
    return row && row.churchId === churchId ? clone(row.data) : null;
  }

  async replaceScriptures(
    churchId: string,
    sermonId: string,
    references: ScriptureReferenceRecord[],
  ) {
    for (const [id, row] of this.db.scriptureRefs)
      if (row.churchId === churchId && row.sermonId === sermonId)
        this.db.scriptureRefs.delete(id);
    for (const ref of references) this.db.scriptureRefs.set(ref.id, clone(ref));
  }

  async listScriptures(churchId: string, sermonId: string) {
    return this.listScripturesForSermons(churchId, [sermonId]);
  }

  async listScripturesForSermons(churchId: string, sermonIds: string[]) {
    return values(this.db.scriptureRefs)
      .filter(
        (ref) => ref.churchId === churchId && sermonIds.includes(ref.sermonId),
      )
      .map(clone);
  }
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export class InMemoryEmbeddingRepository implements EmbeddingRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async replaceForSermon(
    churchId: string,
    sermonId: string,
    rows: EmbeddingRow[],
  ) {
    for (const [id, row] of this.db.embeddings)
      if (row.churchId === churchId && row.sermonId === sermonId)
        this.db.embeddings.delete(id);
    for (const row of rows) this.db.embeddings.set(row.id, clone(row));
  }

  async searchSegments(
    churchId: string,
    vector: number[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]> {
    return values(this.db.embeddings)
      .filter((row) => row.churchId === churchId)
      .filter(
        (row) =>
          this.db.sermons.get(row.sermonId)?.status === 'READY' &&
          this.db.sermons.get(row.sermonId)?.churchId === churchId,
      )
      .filter(
        (row) => !options.sermonIds || options.sermonIds.includes(row.sermonId),
      )
      .map((row) => ({
        sermonId: row.sermonId,
        segmentId: row.transcriptSegmentId,
        content: row.content,
        similarity: cosine(vector, row.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
  }

  async searchSegmentsByKeyword(
    churchId: string,
    keywords: string[],
    options: { limit: number; sermonIds?: string[] },
  ): Promise<SegmentMatch[]> {
    if (keywords.length === 0) return [];
    return values(this.db.embeddings)
      .filter((row) => row.churchId === churchId)
      .filter(
        (row) =>
          this.db.sermons.get(row.sermonId)?.status === 'READY' &&
          this.db.sermons.get(row.sermonId)?.churchId === churchId,
      )
      .filter(
        (row) => !options.sermonIds || options.sermonIds.includes(row.sermonId),
      )
      .map((row) => ({
        sermonId: row.sermonId,
        segmentId: row.transcriptSegmentId,
        content: row.content,
        similarity:
          keywords.filter((word) => row.content.toLowerCase().includes(word))
            .length / keywords.length,
      }))
      .filter((match) => match.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
  }
}

export class InMemoryContentRepository implements ContentRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  async findById(churchId: string, id: string) {
    const row = this.db.contentItems.get(id);
    return row && row.churchId === churchId
      ? ContentItem.restore(clone(row))
      : null;
  }

  async save(item: ContentItem) {
    const props = item.snapshot();
    for (const version of item.pendingVersions()) {
      if (
        this.db.contentVersions.some(
          (existing) =>
            existing.contentItemId === props.id &&
            existing.version === version.version,
        )
      ) {
        throw new Error('unique violation: content version');
      }
      this.db.contentVersions.push({
        ...clone(version),
        contentItemId: props.id,
      });
    }
    this.db.contentItems.set(props.id, clone(props));
  }

  async saveMany(items: ContentItem[]) {
    for (const item of items) await this.save(item);
  }

  async delete(churchId: string, id: string) {
    if (this.db.contentItems.get(id)?.churchId === churchId)
      cascadeDeleteContent(this.db, id);
  }

  async deleteByGenerationJob(churchId: string, generationJobId: string) {
    for (const [id, row] of this.db.contentItems)
      if (row.churchId === churchId && row.generationJobId === generationJobId)
        cascadeDeleteContent(this.db, id);
  }

  async listVersions(
    churchId: string,
    id: string,
  ): Promise<ContentVersionRecord[]> {
    if (this.db.contentItems.get(id)?.churchId !== churchId) return [];
    return this.db.contentVersions
      .filter((version) => version.contentItemId === id)
      .sort((a, b) => b.version - a.version)
      .map(({ contentItemId: _id, ...version }) => clone(version));
  }

  async findVersion(churchId: string, id: string, version: number) {
    return (
      (await this.listVersions(churchId, id)).find(
        (candidate) => candidate.version === version,
      ) ?? null
    );
  }
}

export class InMemoryContentQuery implements ContentQueryPort {
  constructor(private readonly db: InMemoryDb) {}

  private row(item: ContentItemProps): ContentRow {
    const calendar = values(this.db.calendarItems).find(
      (entry) => entry.contentItemId === item.id,
    );
    return {
      ...clone(item),
      sermonTitle: this.db.sermons.get(item.sermonId)?.title ?? '',
      calendarItemId: calendar?.id ?? null,
    };
  }

  async list(
    churchId: string,
    filter: ContentFilter,
    page: PageRequest,
  ): Promise<Page<ContentRow>> {
    const rows = values(this.db.contentItems)
      .filter((item) => item.churchId === churchId)
      .filter((item) =>
        filter.status
          ? item.status === filter.status
          : item.status !== 'ARCHIVED',
      )
      .filter((item) => !filter.type || item.type === filter.type)
      .filter((item) => !filter.sermonId || item.sermonId === filter.sermonId)
      .filter(
        (item) =>
          !filter.generationId ||
          values(this.db.generationJobs).some(
            (job) =>
              job.groupId === filter.generationId &&
              job.id === item.generationJobId,
          ),
      )
      .filter(
        (item) =>
          !filter.q ||
          `${item.title} ${item.body}`
            .toLowerCase()
            .includes(filter.q.toLowerCase()),
      )
      .map((item) => this.row(item))
      .filter(
        (row) =>
          filter.scheduled === undefined ||
          (filter.scheduled
            ? row.calendarItemId !== null
            : row.calendarItemId === null),
      )
      .sort(
        (a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          a.position - b.position,
      );
    return {
      items: rows.slice(skipFor(page), skipFor(page) + page.pageSize),
      total: rows.length,
      ...page,
    };
  }

  async findRows(churchId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const item = this.db.contentItems.get(id);
      return item && item.churchId === churchId ? [this.row(item)] : [];
    });
  }
}

export class InMemoryCalendarRepository implements CalendarRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async findById(churchId: string, id: string) {
    const row = this.db.calendarItems.get(id);
    if (!row || row.churchId !== churchId) return null;
    const { updatedAt: _u, ...props } = clone(row);
    return CalendarItem.restore(props);
  }

  async findByContentItem(churchId: string, contentItemId: string) {
    const row = values(this.db.calendarItems).find(
      (entry) =>
        entry.churchId === churchId && entry.contentItemId === contentItemId,
    );
    if (!row) return null;
    const { updatedAt: _u, ...props } = clone(row);
    return CalendarItem.restore(props);
  }

  async save(item: CalendarItem) {
    this.db.calendarItems.set(item.id, {
      ...clone(item.snapshot()),
      updatedAt: this.clock.now(),
    });
  }

  async delete(churchId: string, id: string) {
    if (this.db.calendarItems.get(id)?.churchId === churchId)
      this.db.calendarItems.delete(id);
  }

  private row(entry: {
    id: string;
    contentItemId: string;
    scheduledAt: Date;
    status: CalendarRow['status'];
  }): CalendarRow {
    const item = this.db.contentItems.get(entry.contentItemId);
    return {
      id: entry.id,
      contentItemId: entry.contentItemId,
      scheduledAt: entry.scheduledAt,
      status: entry.status,
      content: {
        id: item?.id ?? '',
        type: item?.type ?? 'DEVOTIONAL',
        title: item?.title ?? '',
        status: item?.status ?? 'DRAFT',
        sermonId: item?.sermonId ?? '',
        sermonTitle: item
          ? (this.db.sermons.get(item.sermonId)?.title ?? '')
          : '',
      },
    };
  }

  async findRows(churchId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const entry = this.db.calendarItems.get(id);
      return entry && entry.churchId === churchId ? [this.row(entry)] : [];
    });
  }

  async listRange(churchId: string, from: Date, to: Date) {
    return values(this.db.calendarItems)
      .filter(
        (entry) =>
          entry.churchId === churchId &&
          entry.scheduledAt >= from &&
          entry.scheduledAt <= to,
      )
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .map((entry) => this.row(entry));
  }
}

export class InMemoryGenerationRepository implements GenerationRepositoryPort {
  private sequence = 0;

  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  private group(id: string): GenerationGroupRecord | null {
    const group = this.db.generationGroups.get(id);
    if (!group) return null;
    const jobs = values(this.db.generationJobs)
      .filter((job) => job.groupId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ createdAt: _c, updatedAt: _u, ...job }) => clone(job));
    return { ...clone(group), jobs };
  }

  async latestGroup(churchId: string, sermonId: string) {
    const latest = values(this.db.generationGroups)
      .filter(
        (group) => group.churchId === churchId && group.sermonId === sermonId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return latest ? this.group(latest.id) : null;
  }

  async findGroup(churchId: string, sermonId: string, groupId: string) {
    const group = this.db.generationGroups.get(groupId);
    return group && group.churchId === churchId && group.sermonId === sermonId
      ? this.group(groupId)
      : null;
  }

  async createGroup(group: Omit<GenerationGroupRecord, 'jobs'>) {
    this.db.generationGroups.set(group.id, clone(group));
  }

  async addJobs(jobs: GenerationJobRecord[]) {
    for (const job of jobs) {
      if (
        values(this.db.generationJobs).some(
          (existing) =>
            existing.groupId === job.groupId &&
            existing.contentType === job.contentType,
        )
      ) {
        throw new Error('unique violation: generation job');
      }
      this.db.generationJobs.set(job.id, {
        ...clone(job),
        createdAt: new Date(Date.UTC(2026, 0, 1) + ++this.sequence),
        updatedAt: this.clock.now(),
      });
    }
  }

  async findJob(churchId: string, jobId: string) {
    const job = this.db.generationJobs.get(jobId);
    if (!job || job.churchId !== churchId) return null;
    const { createdAt: _c, updatedAt: _u, ...record } = clone(job);
    return record;
  }

  async updateJob(job: GenerationJobRecord) {
    const existing = this.db.generationJobs.get(job.id);
    if (existing && existing.churchId === job.churchId)
      Object.assign(existing, {
        status: job.status,
        attempts: job.attempts,
        errorMessage: job.errorMessage,
        updatedAt: this.clock.now(),
      });
  }

  async failStale(olderThan: Date, errorMessage: string) {
    let failed = 0;
    for (const job of this.db.generationJobs.values()) {
      if (
        ['QUEUED', 'PROCESSING', 'RETRYING'].includes(job.status) &&
        job.updatedAt < olderThan
      ) {
        Object.assign(job, {
          status: 'FAILED',
          errorMessage,
          updatedAt: this.clock.now(),
        });
        failed++;
      }
    }
    return failed;
  }
}

export class InMemoryUsage
  implements UsageMeterPort, AIUsageRecorderPort, UsageQueryPort
{
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async record(entry: UsageRecord | AIUsageEntry) {
    if ('unit' in entry) {
      if (
        entry.dedupeKey &&
        this.db.usageEvents.some((event) => event.dedupeKey === entry.dedupeKey)
      )
        return;
      this.db.usageEvents.push({ ...entry, createdAt: this.clock.now() });
    } else {
      this.db.aiUsageLogs.push({ ...entry, createdAt: this.clock.now() });
    }
  }

  async total(churchId: string, unit: UsageUnit, from: Date, to: Date) {
    return this.db.usageEvents
      .filter(
        (event) =>
          event.churchId === churchId &&
          event.unit === unit &&
          event.createdAt >= from &&
          event.createdAt < to,
      )
      .reduce((sum, event) => sum + event.quantity, 0);
  }

  async deleteBefore(cutoff: Date) {
    const before = this.db.aiUsageLogs.length;
    this.db.aiUsageLogs = this.db.aiUsageLogs.filter(
      (log) => (log.createdAt as Date) >= cutoff,
    );
    return before - this.db.aiUsageLogs.length;
  }
}

/** AI usage logs are recorded separately so the metered model and usage meter can share one store. */
export class InMemoryAIUsageRecorder implements AIUsageRecorderPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async record(entry: AIUsageEntry) {
    this.db.aiUsageLogs.push({ ...entry, createdAt: this.clock.now() });
  }

  async deleteBefore(cutoff: Date) {
    const before = this.db.aiUsageLogs.length;
    this.db.aiUsageLogs = this.db.aiUsageLogs.filter(
      (log) => (log.createdAt as Date) >= cutoff,
    );
    return before - this.db.aiUsageLogs.length;
  }
}

export class InMemorySubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async findByChurch(churchId: string) {
    const row = this.db.subscriptions.get(churchId);
    return row ? clone(row) : null;
  }

  async upsert(subscription: SubscriptionRecord) {
    this.db.subscriptions.set(subscription.churchId, clone(subscription));
  }

  async upsertAllowance(input: {
    churchId: string;
    planId: string;
    sermonsLimit: number;
    periodStart: Date;
    periodEnd: Date;
  }) {
    this.db.allowances.set(input.churchId, clone(input));
  }

  async linkCustomer(input: {
    churchId: string;
    provider: string;
    externalCustomerId: string;
  }) {
    this.db.billingCustomers.set(input.churchId, clone(input));
  }

  async findChurchByCustomer(provider: string, externalCustomerId: string) {
    return (
      values(this.db.billingCustomers).find(
        (c) =>
          c.provider === provider &&
          c.externalCustomerId === externalCustomerId,
      )?.churchId ?? null
    );
  }

  async findChurchBySubscription(
    provider: string,
    externalSubscriptionId: string,
  ) {
    return (
      values(this.db.subscriptions).find(
        (s) =>
          s.provider === provider &&
          s.externalSubscriptionId === externalSubscriptionId,
      )?.churchId ?? null
    );
  }

  async findOwnerEmail(churchId: string) {
    const church = this.db.churches.get(churchId);
    return church ? (this.db.users.get(church.userId)?.email ?? null) : null;
  }

  async deleteWebhookEventsBefore(cutoff: Date) {
    let deleted = 0;
    for (const [key, receivedAt] of this.db.webhookEvents)
      if (receivedAt < cutoff && this.db.webhookEvents.delete(key)) deleted++;
    return deleted;
  }

  async recordWebhookEvent(input: { provider: string; eventId: string }) {
    const key = `${input.provider}:${input.eventId}`;
    if (this.db.webhookEvents.has(key)) return false;
    this.db.webhookEvents.set(key, this.clock.now());
    return true;
  }
}

export class InMemoryIntegrationRepository implements IntegrationRepositoryPort {
  constructor(private readonly db: InMemoryDb) {}

  private key = (churchId: string, provider: IntegrationProvider) =>
    `${churchId}:${provider}`;

  async list(churchId: string) {
    return values(this.db.integrations)
      .filter((row) => row.churchId === churchId)
      .map(clone);
  }

  async find(churchId: string, provider: IntegrationProvider) {
    const row = this.db.integrations.get(this.key(churchId, provider));
    return row ? clone(row) : null;
  }

  async upsert(record: IntegrationRecord) {
    this.db.integrations.set(
      this.key(record.churchId, record.provider),
      clone(record),
    );
  }

  async setStatus(
    churchId: string,
    provider: IntegrationProvider,
    status: IntegrationRecord['status'],
  ) {
    const row = this.db.integrations.get(this.key(churchId, provider));
    if (row) row.status = status;
  }

  async delete(churchId: string, provider: IntegrationProvider) {
    this.db.integrations.delete(this.key(churchId, provider));
  }
}

export class InMemoryPublishingRepository implements PublishingRepositoryPort {
  constructor(
    private readonly db: InMemoryDb,
    private readonly clock: TestClock,
  ) {}

  async claimDue(
    now: Date,
    types: ContentType[],
    limit: number,
  ): Promise<DueItem[]> {
    const due = values(this.db.calendarItems)
      .filter(
        (entry) => entry.status === 'SCHEDULED' && entry.scheduledAt <= now,
      )
      .filter((entry) => {
        const item = this.db.contentItems.get(entry.contentItemId);
        return item?.status === 'SCHEDULED' && types.includes(item.type);
      })
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .slice(0, limit);
    for (const entry of due) {
      entry.status = 'PUBLISHING';
      entry.updatedAt = this.clock.now();
    }
    return due.map((entry) => ({
      calendarItemId: entry.id,
      churchId: entry.churchId,
      contentItemId: entry.contentItemId,
      scheduledAt: entry.scheduledAt,
    }));
  }

  async releaseStale(olderThan: Date) {
    let released = 0;
    for (const entry of this.db.calendarItems.values()) {
      const key = `${entry.id}:${entry.scheduledAt.toISOString()}`;
      if (
        entry.status === 'PUBLISHING' &&
        entry.updatedAt < olderThan &&
        !values(this.db.publishAttempts).some((a) => a.idempotencyKey === key)
      ) {
        entry.status = 'SCHEDULED';
        released++;
      }
    }
    return released;
  }

  async findAttempt(idempotencyKey: string) {
    const row = values(this.db.publishAttempts).find(
      (attempt) => attempt.idempotencyKey === idempotencyKey,
    );
    return row ? clone(row) : null;
  }

  async createAttempt(attempt: Omit<PublishAttemptRecord, 'updatedAt'>) {
    if (
      values(this.db.publishAttempts).some(
        (existing) => existing.idempotencyKey === attempt.idempotencyKey,
      )
    )
      return false;
    this.db.publishAttempts.set(attempt.id, {
      ...clone(attempt),
      updatedAt: this.clock.now(),
    });
    return true;
  }

  async reopenAttempt(id: string) {
    const row = this.db.publishAttempts.get(id);
    if (
      !row ||
      row.status !== 'FAILED' ||
      !row.errorMessage?.startsWith('definite:')
    )
      return false;
    row.status = 'PENDING';
    row.errorMessage = null;
    return true;
  }

  async completeAttempt(
    id: string,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED';
      externalId?: string | null;
      errorMessage?: string | null;
      definite?: boolean;
    },
  ) {
    const row = this.db.publishAttempts.get(id);
    if (!row) return;
    row.status = outcome.status;
    row.externalId = outcome.externalId ?? null;
    row.errorMessage =
      outcome.status === 'FAILED'
        ? `${outcome.definite ? 'definite' : 'uncertain'}: ${outcome.errorMessage ?? ''}`
        : null;
    row.updatedAt = this.clock.now();
  }

  async setCalendarStatus(
    churchId: string,
    calendarItemId: string,
    status: 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
  ) {
    const entry = this.db.calendarItems.get(calendarItemId);
    if (entry && entry.churchId === churchId) entry.status = status;
  }
}

export class InMemoryLibraryFacets implements LibraryFacetsPort {
  constructor(private readonly db: InMemoryDb) {}

  async facets(churchId: string): Promise<LibraryFacets> {
    const ready = values(this.db.sermons).filter(
      (sermon) => sermon.churchId === churchId && sermon.status === 'READY',
    );
    const distinct = (list: Array<string | null>) =>
      [
        ...new Set(list.filter((value): value is string => Boolean(value))),
      ].sort();
    return {
      speakers: distinct(ready.map((s) => s.speaker)),
      series: distinct(ready.map((s) => s.series)),
      scriptures: distinct(ready.flatMap((s) => s.scriptures)),
      themes: distinct(ready.flatMap((s) => s.themes)),
      tags: distinct(ready.flatMap((s) => s.tags)),
      years: [...new Set(ready.map((s) => lagosYear(s.sermonDate)))]
        .sort((a, b) => b - a)
        .map(String),
    };
  }
}

export class InMemoryAnalyticsQuery implements AnalyticsQueryPort {
  constructor(private readonly db: InMemoryDb) {}

  async metrics(churchId: string): Promise<ProductMetrics> {
    const sermons = values(this.db.sermons).filter(
      (s) => s.churchId === churchId,
    );
    const content = values(this.db.contentItems).filter(
      (c) => c.churchId === churchId,
    );
    const count = <T extends { status: string }>(
      rows: T[],
      statuses?: string[],
    ) =>
      rows.filter((row) =>
        statuses ? statuses.includes(row.status) : row.status !== 'ARCHIVED',
      ).length;
    return {
      sermonsUploaded: count(sermons),
      sermonsProcessed: count(sermons, ['READY']),
      contentGenerated: count(content),
      contentApproved: count(content, ['APPROVED', 'SCHEDULED', 'PUBLISHED']),
      contentScheduled: count(content, ['SCHEDULED']),
      contentPublished: count(content, ['PUBLISHED']),
      processingFailures: count(sermons, ['FAILED']),
      generationFailures: values(this.db.generationJobs).filter(
        (job) => job.churchId === churchId && job.status === 'FAILED',
      ).length,
    };
  }

  async sermonsCreatedBetween(churchId: string, from: Date, to: Date) {
    return values(this.db.sermons).filter(
      (s) =>
        s.churchId === churchId &&
        s.status !== 'ARCHIVED' &&
        s.createdAt >= from &&
        s.createdAt < to,
    ).length;
  }
}
