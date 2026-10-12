import type { ContentType } from '../../../../content/domain/content-types.js';
import type { IntegrationProvider } from '../../../../integrations/domain/integration.js';

export interface PublishInput {
  idempotencyKey: string;
  credentials: Record<string, string>;
  content: { type: ContentType; title: string; body: string };
}

export type PublishResult =
  | { ok: true; externalId: string }
  /** `definite` = the provider certainly did not publish (safe to retry); otherwise the outcome is unknown. */
  | {
      ok: false;
      retryable: boolean;
      definite: boolean;
      credentialsInvalid: boolean;
      message: string;
    };

export interface PublishingProviderPort {
  readonly provider: IntegrationProvider;
  publish(input: PublishInput): Promise<PublishResult>;
}

export const PUBLISHING_PROVIDERS = Symbol('PUBLISHING_PROVIDERS');

export type PublishAttemptStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface PublishAttemptRecord {
  id: string;
  churchId: string;
  contentItemId: string;
  provider: IntegrationProvider;
  idempotencyKey: string;
  status: PublishAttemptStatus;
  externalId: string | null;
  errorMessage: string | null;
  updatedAt: Date;
}

export interface DueItem {
  calendarItemId: string;
  churchId: string;
  contentItemId: string;
  scheduledAt: Date;
}

export const PUBLISHING_REPOSITORY = Symbol('PUBLISHING_REPOSITORY');

export interface PublishingRepositoryPort {
  /** Atomically moves due SCHEDULED items to PUBLISHING (SKIP LOCKED, so concurrent dispatchers never double-claim). */
  claimDue(now: Date, types: ContentType[], limit: number): Promise<DueItem[]>;
  /** Returns PUBLISHING items stuck longer than `olderThan` (crashed workers) back to SCHEDULED. */
  releaseStale(olderThan: Date): Promise<number>;
  findAttempt(idempotencyKey: string): Promise<PublishAttemptRecord | null>;
  /** Inserts a PENDING attempt; false if another worker already holds this idempotency key. */
  createAttempt(
    attempt: Omit<PublishAttemptRecord, 'updatedAt'>,
  ): Promise<boolean>;
  /** Moves a definitively FAILED attempt back to PENDING; false if not in FAILED state. */
  reopenAttempt(id: string): Promise<boolean>;
  completeAttempt(
    id: string,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED';
      externalId?: string | null;
      errorMessage?: string | null;
      definite?: boolean;
    },
  ): Promise<void>;
  setCalendarStatus(
    churchId: string,
    calendarItemId: string,
    status: 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
  ): Promise<void>;
}
