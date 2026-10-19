import { ContentItem, type GenerationGroupRecord, planGeneration } from './helper.js';

const now = new Date('2026-10-05T09:00:00Z');
const ai = { provider: 'openai', model: 'gpt' };
const generate = () =>
  ContentItem.generate({
    id: 'ci1',
    churchId: 'c1',
    sermonId: 's1',
    generationJobId: 'j1',
    type: 'DEVOTIONAL',
    position: 1,
    title: 'Day 1',
    body: 'Body',
    scripture: 'John 3:16',
    sourceMetadata: {
      sermonId: 's1',
      transcriptSegmentIds: [],
      scriptureReferenceIds: [],
      startTimeMs: null,
      endTimeMs: null,
      verbatim: false,
    },
    ai,
    now,
  });

describe('ContentItem', () => {
  it('is generated as a DRAFT with an AI_GENERATED first version', () => {
    const item = generate();
    expect(item.status).toBe('DRAFT');
    expect(item.pendingVersions()).toEqual([
      expect.objectContaining({
        version: 1,
        source: 'AI_GENERATED',
        aiProvider: 'openai',
        aiModel: 'gpt',
      }),
    ]);
  });

  it('versions every edit and attributes user edits to no provider', () => {
    const item = generate();
    item.edit({ body: 'Edited' }, now);
    item.applyAIRevision(
      { title: 'Day 1', body: 'Shorter', scripture: null },
      'AI_REWRITE',
      ai,
      now,
    );
    expect(
      item.pendingVersions().map((v) => [v.version, v.source, v.aiProvider]),
    ).toEqual([
      [1, 'AI_GENERATED', 'openai'],
      [2, 'USER_EDIT', null],
      [3, 'AI_REWRITE', 'openai'],
    ]);
    expect(item.snapshot().currentVersion).toBe(3);
  });

  it('moves approved/scheduled content back to DRAFT on edit and requests unscheduling', () => {
    const item = generate();
    item.approve(now);
    expect(item.edit({ title: 'New' }, now)).toEqual({ unschedule: true });
    expect(item.status).toBe('DRAFT');
    item.approve(now);
    item.schedule(new Date('2026-10-10T00:00:00Z'), now);
    expect(item.edit({ title: 'Again' }, now)).toEqual({ unschedule: true });
    expect(item.snapshot()).toMatchObject({
      status: 'DRAFT',
      scheduledAt: null,
    });
  });

  it('only schedules approved content', () => {
    const item = generate();
    expect(() => item.schedule(new Date(), now)).toThrow(
      expect.objectContaining({ code: 'CONTENT_NOT_APPROVED' }),
    );
  });

  it('locks published content', () => {
    const item = generate();
    item.approve(now);
    item.schedule(new Date('2026-10-10T00:00:00Z'), now);
    item.markPublished(new Date('2026-10-10T00:00:00Z'));
    expect(() => item.edit({ body: 'x' }, now)).toThrow(
      expect.objectContaining({ code: 'CONTENT_LOCKED' }),
    );
    expect(() => item.approve(now)).toThrow(
      expect.objectContaining({ code: 'CONTENT_LOCKED' }),
    );
  });

  it('restores an old version as a new USER_EDIT version', () => {
    const item = generate();
    item.edit({ body: 'Changed' }, now);
    item.restoreVersion(
      {
        version: 1,
        title: 'Day 1',
        body: 'Body',
        scripture: 'John 3:16',
        source: 'AI_GENERATED',
        aiProvider: 'openai',
        aiModel: 'gpt',
        createdAt: now,
      },
      now,
    );
    expect(item.body).toBe('Body');
    expect(item.pendingVersions().at(-1)).toMatchObject({
      version: 3,
      source: 'USER_EDIT',
      body: 'Body',
    });
  });
});


const group = (
  jobs: Array<[string, GenerationGroupRecord['jobs'][number]['status']]>,
): GenerationGroupRecord => ({
  id: 'g1',
  churchId: 'c1',
  sermonId: 's1',
  createdAt: new Date(),
  jobs: jobs.map(([contentType, status], i) => ({
    id: `j${i}`,
    groupId: 'g1',
    churchId: 'c1',
    sermonId: 's1',
    contentType: contentType as never,
    status,
    attempts: 1,
    errorMessage: null,
  })),
});

describe('planGeneration', () => {
  it('creates a new group when none exists', () => {
    expect(planGeneration(null, ['DEVOTIONAL', 'DEVOTIONAL', 'QUOTE'])).toEqual(
      { reuse: false, requeue: [], add: ['DEVOTIONAL', 'QUOTE'] },
    );
  });

  it('re-queues only failed types in the latest group ("Retry failed")', () => {
    const latest = group([
      ['DEVOTIONAL', 'COMPLETED'],
      ['QUOTE', 'FAILED'],
    ]);
    expect(planGeneration(latest, ['QUOTE'])).toEqual({
      reuse: true,
      requeue: ['QUOTE'],
      add: [],
    });
    expect(planGeneration(latest, ['DEVOTIONAL', 'QUOTE', 'PRAYER'])).toEqual({
      reuse: true,
      requeue: ['QUOTE'],
      add: ['PRAYER'],
    });
  });

  it('does not duplicate in-flight work', () => {
    const latest = group([['DEVOTIONAL', 'PROCESSING']]);
    expect(planGeneration(latest, ['DEVOTIONAL'])).toEqual({
      reuse: true,
      requeue: [],
      add: [],
    });
  });

  it('starts fresh when every requested type already completed', () => {
    const latest = group([['DEVOTIONAL', 'COMPLETED']]);
    expect(planGeneration(latest, ['DEVOTIONAL'])).toEqual({
      reuse: false,
      requeue: [],
      add: ['DEVOTIONAL'],
    });
  });
});
