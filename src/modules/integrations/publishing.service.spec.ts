import { CalendarItem, ContentItem } from '../content/helper.js';
import type { PublishingProviderPort, PublishResult } from './adapters/ports.js';
import type { PublishAttemptRecord } from './helper.js';
import type { PublishingRepositoryPort } from './integrations.repository.js';
import { PublishingService } from './publishing.service.js';

const now = new Date('2026-10-05T12:00:00Z');
const scheduledAt = new Date('2026-10-05T11:59:00Z');

function setup(
  result: PublishResult,
  existing: PublishAttemptRecord | null = null,
) {
  const item = ContentItem.generate({
    id: 'ci1',
    churchId: 'c1',
    sermonId: 's1',
    generationJobId: null,
    type: 'EMAIL',
    position: 1,
    title: 'Post',
    body: 'Body',
    scripture: null,
    sourceMetadata: {
      sermonId: 's1',
      transcriptSegmentIds: [],
      scriptureReferenceIds: [],
      startTimeMs: null,
      endTimeMs: null,
      verbatim: false,
    },
    ai: { provider: 'x', model: 'y' },
    now,
  });
  item.approve(now);
  item.schedule(scheduledAt, new Date('2026-10-01T00:00:00Z'));
  const calendar = CalendarItem.restore({
    id: 'cal1',
    churchId: 'c1',
    contentItemId: 'ci1',
    scheduledAt,
    status: 'PUBLISHING',
  });
  const attempts: PublishAttemptRecord[] = existing ? [existing] : [];
  const calendarStatuses: string[] = [];
  const publishing: PublishingRepositoryPort = {
    claimDue: async () => [],
    releaseStale: async () => 0,
    findAttempt: async (key) =>
      attempts.find((a) => a.idempotencyKey === key) ?? null,
    createAttempt: async (attempt) => {
      attempts.push({ ...attempt, updatedAt: now });
      return true;
    },
    reopenAttempt: async () => true,
    completeAttempt: async (id, outcome) => {
      Object.assign(attempts.find((a) => a.id === id) ?? {}, {
        status: outcome.status,
        errorMessage: `${outcome.definite ? 'definite' : 'uncertain'}: ${outcome.errorMessage ?? ''}`,
      });
    },
    setCalendarStatus: async (_c, _id, status) =>
      void calendarStatuses.push(status),
  };
  const calls: unknown[] = [];
  const provider: PublishingProviderPort = {
    provider: 'EMAIL',
    publish: async (input) => {
      calls.push(input);
      return result;
    },
  };
  const contents = {
    findById: async () => item,
    save: async () => undefined,
  } as never;
  const useCase = new PublishingService(
    publishing,
    [provider],
    { findById: async () => calendar } as never,
    contents,
    {
      credentialsFor: async () => ({ accessToken: 't', apiEndpoint: 'x', listId: 'l' }),
      markNeedsAttention: async () => undefined,
    } as never,
    {} as never,
    {
      run: (fn: () => Promise<unknown>) => fn(),
      runLocked: (_k: string, fn: () => Promise<unknown>) => fn(),
    } as never,
    { now: () => now },
    {} as never,
  );
  const payload = {
    churchId: 'c1',
    calendarItemId: 'cal1',
    contentItemId: 'ci1',
    scheduledAt: scheduledAt.toISOString(),
  };
  return { useCase, payload, calls, attempts, calendarStatuses, item };
}

const context = (attempt: number, maxAttempts = 5) => ({
  jobId: 'j',
  attempt,
  maxAttempts,
  isFinalAttempt: attempt >= maxAttempts,
  signal: new AbortController().signal,
});

describe('PublishingService.publish', () => {
  it('publishes once and marks content PUBLISHED', async () => {
    const { useCase, payload, calls, calendarStatuses, item } = setup({
      ok: true,
      externalId: 'post-1',
    });
    await useCase.publish(payload, context(1));
    expect(calls).toHaveLength(1);
    expect(calendarStatuses).toEqual(['PUBLISHED']);
    expect(item.status).toBe('PUBLISHED');
  });

  it('never retries when the outcome is unknown (avoids duplicate posts)', async () => {
    const { useCase, payload, calendarStatuses, item } = setup({
      ok: false,
      retryable: true,
      definite: false,
      credentialsInvalid: false,
      message: 'timeout',
    });
    await expect(useCase.publish(payload, context(1))).resolves.toBeUndefined();
    expect(calendarStatuses).toEqual(['FAILED']);
    expect(item.status).toBe('FAILED');
  });

  it('retries definite, retryable provider failures via the queue', async () => {
    const { useCase, payload } = setup({
      ok: false,
      retryable: true,
      definite: true,
      credentialsInvalid: false,
      message: '503',
    });
    await expect(useCase.publish(payload, context(1))).rejects.toThrow(
      /Retryable/,
    );
  });

  it('does not publish again after a crash left a PENDING attempt', async () => {
    const key = `cal1:${scheduledAt.toISOString()}`;
    const { useCase, payload, calls, calendarStatuses } = setup(
      { ok: true, externalId: 'dup' },
      {
        id: 'a1',
        churchId: 'c1',
        contentItemId: 'ci1',
        provider: 'EMAIL',
        idempotencyKey: key,
        status: 'PENDING',
        externalId: null,
        errorMessage: null,
        updatedAt: now,
      },
    );
    await useCase.publish(payload, context(2));
    expect(calls).toHaveLength(0);
    expect(calendarStatuses).toEqual(['FAILED']);
  });
});
