import { fakeCapabilities } from '../../../test/support/social-fakes.js';
import { capabilityViolations } from './helper.js';
import { asSocialProviderError, SocialProviderError } from './helper.js';
import { needsRefresh } from './helper.js';
import {
  assertDeletable,
  assertEditable,
  derivePostStatus,
  effectivePostStatus,
  type PublicationStatus,
  retryablePublications,
  type SocialPostAggregate,
  startablePublications,
  titleFor,
  validateScheduleTime,
} from './helper.js';
import { validateTargetSettings } from './helper.js';

const statuses = (...list: PublicationStatus[]) =>
  list.map((status) => ({ status }));

const aggregate = (
  ...publications: Array<{
    status: PublicationStatus;
    outcomeUnknown?: boolean;
    id?: string;
  }>
): SocialPostAggregate =>
  ({
    post: { status: 'ready' },
    publications: publications.map((publication, index) => ({
      id: publication.id ?? `p${index}`,
      outcomeUnknown: false,
      ...publication,
    })),
  }) as unknown as SocialPostAggregate;

describe('post status', () => {
  it('treats partial success as a first-class state', () => {
    const post = { status: 'publishing' as const };
    expect(derivePostStatus(post, statuses('published', 'published'))).toBe(
      'published',
    );
    expect(
      derivePostStatus(post, statuses('published', 'failed', 'published')),
    ).toBe('partially_published');
    expect(derivePostStatus(post, statuses('failed', 'failed'))).toBe('failed');
    expect(derivePostStatus(post, statuses('published', 'processing'))).toBe(
      'publishing',
    );
    expect(derivePostStatus(post, statuses('queued', 'queued'))).toBe('queued');
    expect(derivePostStatus(post, statuses('queued', 'failed'))).toBe(
      'publishing',
    );
    expect(derivePostStatus({ status: 'ready' }, statuses('scheduled'))).toBe(
      'scheduled',
    );
    expect(derivePostStatus({ status: 'ready' }, statuses('pending'))).toBe(
      'ready',
    );
    expect(derivePostStatus({ status: 'ready' }, [])).toBe('draft');
    expect(effectivePostStatus('ready', true)).toBe('rendering');
    expect(effectivePostStatus('scheduled', true)).toBe('scheduled');
  });

  it('guards edits, deletes, starts and retries', () => {
    expect(() => assertEditable(aggregate({ status: 'queued' }))).toThrow(
      /edited/,
    );
    expect(() =>
      assertDeletable(aggregate({ status: 'published' }, { status: 'failed' })),
    ).toThrow(/live/);
    expect(() =>
      assertDeletable(aggregate({ status: 'processing' })),
    ).toThrow();
    expect(() =>
      assertDeletable(aggregate({ status: 'failed' })),
    ).not.toThrow();
    expect(() => startablePublications(aggregate())).toThrow(/at least one/);
    expect(
      startablePublications(
        aggregate({ status: 'pending' }, { status: 'failed' }),
      ),
    ).toHaveLength(1);

    const mixed = aggregate(
      { status: 'failed', id: 'a' },
      { status: 'failed', outcomeUnknown: true, id: 'b' },
    );
    expect(() =>
      retryablePublications(mixed, { confirmNotPublished: false }),
    ).toThrow(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
    expect(
      retryablePublications(mixed, {
        publicationIds: ['a'],
        confirmNotPublished: false,
      }),
    ).toHaveLength(1);
    expect(
      retryablePublications(mixed, { confirmNotPublished: true }),
    ).toHaveLength(2);
  });

  it('validates schedule times and titles', () => {
    const now = new Date('2026-10-05T09:00:00Z');
    expect(() =>
      validateScheduleTime(new Date('2026-10-05T09:00:30Z'), now),
    ).toThrow();
    expect(() =>
      validateScheduleTime(new Date('2028-01-01T00:00:00Z'), now),
    ).toThrow();
    expect(() =>
      validateScheduleTime(new Date('2026-10-06T09:00:00Z'), now),
    ).not.toThrow();
    expect(titleFor({ caption: 'First line\nsecond' }, 100)).toBe('First line');
    expect(titleFor({ caption: 'x'.repeat(200) }, 100)).toHaveLength(100);
  });
});

describe('capabilities', () => {
  const image = {
    type: 'image' as const,
    contentType: 'image/jpeg',
    sizeBytes: 1000,
    durationMs: null,
  };
  const video = {
    type: 'video' as const,
    contentType: 'video/mp4',
    sizeBytes: 1000,
    durationMs: 30_000,
  };

  it('reports what a platform cannot accept', () => {
    expect(
      capabilityViolations(fakeCapabilities('instagram'), {
        caption: 'hi',
        media: [],
      }),
    ).toEqual(['This platform needs an image or a video.']);
    expect(
      capabilityViolations(fakeCapabilities('x'), {
        caption: 'x'.repeat(281),
        media: [],
      })[0],
    ).toMatch(/too long/);
    expect(
      capabilityViolations(fakeCapabilities('x'), {
        caption: 'hi',
        media: Array(5).fill(image),
      }),
    ).toEqual(['Use at most 4 images.']);
    expect(
      capabilityViolations(fakeCapabilities('facebook'), {
        caption: 'hi',
        media: [image, video],
      }),
    ).toContain('Use either images or one video, not both.');
    expect(
      capabilityViolations(fakeCapabilities('tiktok'), {
        caption: 'hi',
        media: [{ ...video, durationMs: 1_000 }],
      })[0],
    ).toMatch(/at least 3 seconds/);
    expect(
      capabilityViolations(fakeCapabilities('youtube'), {
        caption: 'hi',
        media: [image],
      }),
    ).toContain('This platform does not accept images.');
    expect(
      capabilityViolations(fakeCapabilities('linkedin', false), {
        caption: 'hi',
        media: [],
      }),
    ).toContain('Publishing to this platform is not available yet.');
    // Unknown facts (still rendering) are not held against the post yet.
    expect(
      capabilityViolations(fakeCapabilities('tiktok'), {
        caption: 'hi',
        media: [{ ...video, durationMs: null }],
      }),
    ).toEqual([]);
  });
});

describe('errors', () => {
  it('never makes an unknown outcome retryable', () => {
    expect(new SocialProviderError('RATE_LIMITED', 'x').retryable).toBe(true);
    expect(
      new SocialProviderError('PROVIDER_UNAVAILABLE', 'x', {
        outcome: 'unknown',
        retryable: true,
      }).retryable,
    ).toBe(false);
    expect(new SocialProviderError('AUTH_EXPIRED', 'x').retryable).toBe(false);
    expect(asSocialProviderError(new Error('boom'), true)).toMatchObject({
      code: 'UNKNOWN',
      outcome: 'unknown',
    });
    expect(asSocialProviderError(new Error('boom'), false)).toMatchObject({
      outcome: 'not_published',
    });
  });

  it('refreshes tokens shortly before they expire', () => {
    const now = new Date('2026-10-05T09:00:00Z');
    expect(
      needsRefresh({ tokenExpiresAt: new Date('2026-10-05T09:03:00Z') }, now),
    ).toBe(true);
    expect(
      needsRefresh({ tokenExpiresAt: new Date('2026-10-05T10:00:00Z') }, now),
    ).toBe(false);
    expect(needsRefresh({ tokenExpiresAt: undefined }, now)).toBe(false);
  });
});

describe('target settings', () => {
  it('requires the choices platform policies demand', () => {
    expect(() => validateTargetSettings('tiktok', {})).toThrow();
    expect(
      validateTargetSettings('tiktok', {
        privacyLevel: 'SELF_ONLY',
        extra: 'dropped',
      }),
    ).toEqual({
      privacyLevel: 'SELF_ONLY',
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
    });
    expect(() =>
      validateTargetSettings('youtube', { privacyStatus: 'public' }),
    ).toThrow();
    expect(
      validateTargetSettings('youtube', {
        privacyStatus: 'unlisted',
        madeForKids: false,
        tags: ['a', ' ', 1],
      }),
    ).toEqual({
      privacyStatus: 'unlisted',
      madeForKids: false,
      tags: ['a'],
    });
    expect(
      validateTargetSettings('linkedin', { visibility: 'ANYONE' }),
    ).toEqual({ visibility: 'PUBLIC' });
  });
});
