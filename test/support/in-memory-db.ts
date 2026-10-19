import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWorkPort } from '../../src/shared/application/ports/unit-of-work.port.js';
import type { UsageUnit } from '../../src/shared/application/ports/usage-meter.port.js';
import type {
  EmailVerificationRecord,
  PasswordResetRecord,
  SessionRecord,
  UserRecord,
} from '../../src/modules/auth/auth.repository.js';
import type { ChurchRecord } from '../../src/modules/auth/auth.repository.js';
import type { UploadRecord } from '../../src/modules/uploads/application/ports/out/upload-repository.port.js';
import type { SermonProps } from '../../src/modules/sermons/domain/sermon.entity.js';
import type { SermonAssetRecord } from '../../src/modules/sermons/application/ports/out/sermon-repository.port.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../src/modules/sermons/domain/sermon-intelligence.js';
import type { EmbeddingRow } from '../../src/modules/sermons/application/ports/out/transcript-repository.port.js';
import type {
  ContentItemProps,
  ContentVersionRecord,
} from '../../src/modules/content/helper.js';
import type { CalendarItemProps } from '../../src/modules/content/helper.js';
import type { GenerationJobRecord } from '../../src/modules/content/helper.js';
import type { SubscriptionRecord } from '../../src/modules/billing/domain/subscription.js';
import type { IntegrationRecord } from '../../src/modules/integrations/domain/integration.js';
import type { BrandProfile, MediaAsset } from '../../src/modules/brand/helper.js';
import type { SocialAuditEntry } from '../../src/modules/social/application/ports/out/social-repositories.port.js';
import type { SocialConnection } from '../../src/modules/social/domain/social-connection.js';
import type {
  SocialPost,
  SocialPublication,
} from '../../src/modules/social/domain/social-post.js';
import type { PublishAttemptRecord } from '../../src/modules/publishing/application/ports/out/publishing.ports.js';

/**
 * Process-local stand-in for PostgreSQL used by every test. Tests never touch a real database
 * (project rule): repositories are exercised through the same ports the Prisma adapters implement.
 */
export class InMemoryDb {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, SessionRecord & { userAgent: string | null }>();
  passwordResets = new Map<string, PasswordResetRecord>();
  emailVerifications = new Map<string, EmailVerificationRecord>();
  churches = new Map<string, ChurchRecord>();
  uploads = new Map<string, UploadRecord>();
  sermons = new Map<string, SermonProps & { updatedAt: Date }>();
  assets = new Map<string, SermonAssetRecord>();
  transcripts = new Map<
    string,
    {
      id: string;
      churchId: string;
      sermonId: string;
      fullText: string;
      language: string | null;
      provider: string;
    }
  >();
  segments = new Map<
    string,
    TranscriptSegmentRecord & {
      churchId: string;
      sermonId: string;
      transcriptId: string;
    }
  >();
  intelligence = new Map<
    string,
    {
      churchId: string;
      sermonId: string;
      data: SermonIntelligence;
      aiProvider: string;
      aiModel: string;
    }
  >();
  scriptureRefs = new Map<string, ScriptureReferenceRecord>();
  embeddings = new Map<string, EmbeddingRow>();
  generationGroups = new Map<
    string,
    { id: string; churchId: string; sermonId: string; createdAt: Date }
  >();
  generationJobs = new Map<
    string,
    GenerationJobRecord & { createdAt: Date; updatedAt: Date }
  >();
  contentItems = new Map<string, ContentItemProps>();
  contentVersions: Array<ContentVersionRecord & { contentItemId: string }> = [];
  calendarItems = new Map<string, CalendarItemProps & { updatedAt: Date }>();
  usageEvents: Array<{
    churchId: string;
    unit: UsageUnit;
    quantity: number;
    sermonId?: string;
    dedupeKey?: string;
    createdAt: Date;
  }> = [];
  aiUsageLogs: Array<Record<string, unknown>> = [];
  subscriptions = new Map<string, SubscriptionRecord>();
  allowances = new Map<
    string,
    {
      churchId: string;
      planId: string;
      sermonsLimit: number;
      periodStart: Date;
      periodEnd: Date;
    }
  >();
  billingCustomers = new Map<
    string,
    { churchId: string; provider: string; externalCustomerId: string }
  >();
  webhookEvents = new Map<string, Date>();
  integrations = new Map<string, IntegrationRecord>();
  publishAttempts = new Map<string, PublishAttemptRecord>();
  brandProfiles = new Map<string, BrandProfile>();
  mediaAssets = new Map<string, MediaAsset>();
  socialConnections = new Map<string, SocialConnection>();
  socialPosts = new Map<string, SocialPost>();
  socialPublications = new Map<string, SocialPublication>();
  socialAudit: Array<SocialAuditEntry & { createdAt: Date }> = [];

  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(Object.entries(this)));
  }

  restore(snapshot: Record<string, unknown>): void {
    Object.assign(this, snapshot);
  }
}

/** Transactions with real rollback (snapshot/restore) and per-key mutual exclusion, like advisory locks. */
export class InMemoryUnitOfWork implements UnitOfWorkPort {
  private readonly active = new AsyncLocalStorage<true>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly db: InMemoryDb) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Only calls made inside an open transaction's async context join it.
    if (this.active.getStore()) return fn();
    const snapshot = this.db.snapshot();
    try {
      return await this.active.run(true, fn);
    } catch (error) {
      this.db.restore(snapshot);
      throw error;
    }
  }

  async runLocked<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      lockKey,
      previous.then(() => current),
    );
    await previous;
    try {
      return await this.run(fn);
    } finally {
      release();
      if (this.locks.get(lockKey) === current) this.locks.delete(lockKey);
    }
  }
}

/** Controllable clock so tests can move time (sessions, schedules, billing periods). */
export class TestClock {
  private current = new Date('2026-10-05T09:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date | string): void {
    this.current = new Date(date);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
