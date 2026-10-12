import {
  type GenerationGroupRecord,
  planGeneration,
} from './generation-group.js';

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
