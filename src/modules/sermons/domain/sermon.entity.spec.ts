import { Sermon } from './sermon.entity.js';

const create = () =>
  Sermon.create({
    id: 's1',
    churchId: 'c1',
    sourceType: 'MEDIA',
    details: {
      title: ' Walking By Faith ',
      speaker: 'Pastor Ade',
      sermonDate: new Date('2026-09-27T09:00:00Z'),
      tags: ['Faith', 'faith', ' Hope '],
    },
    now: new Date('2026-09-28T00:00:00Z'),
  });

describe('Sermon', () => {
  it('starts queued at the UPLOAD stage with normalised details', () => {
    const sermon = create().snapshot();
    expect(sermon).toMatchObject({
      status: 'QUEUED',
      processingStage: 'UPLOAD',
      title: 'Walking By Faith',
      tags: ['faith', 'hope'],
      processingAttempts: 1,
    });
  });

  it('maps stages to statuses as it moves through the pipeline', () => {
    const sermon = create();
    sermon.enterStage('TRANSCRIBE');
    expect(sermon.status).toBe('TRANSCRIBING');
    sermon.enterStage('SCRIPTURES');
    expect(sermon.status).toBe('ANALYZING');
    sermon.enterStage('INDEX');
    expect(sermon.status).toBe('INDEXING');
    sermon.markReady(new Date());
    expect(sermon.snapshot()).toMatchObject({
      status: 'READY',
      processingStage: null,
    });
    expect(() => sermon.enterStage('INDEX')).toThrow(/ready/);
  });

  it('records failure and resumes from the failed stage on retry', () => {
    const sermon = create();
    sermon.enterStage('UNDERSTAND');
    sermon.markFailed('UNDERSTAND', 'Could not analyse.', true);
    expect(sermon.acceptsJobFor(1)).toBe(false);
    expect(sermon.retry()).toBe('UNDERSTAND');
    expect(sermon.snapshot()).toMatchObject({
      status: 'QUEUED',
      processingStage: 'UNDERSTAND',
      processingAttempts: 2,
      failedStage: null,
    });
    expect(sermon.acceptsJobFor(1)).toBe(false); // jobs from the superseded run are ignored
    expect(sermon.acceptsJobFor(2)).toBe(true);
  });

  it('refuses retries that are not allowed', () => {
    const sermon = create();
    expect(() => sermon.retry()).toThrow(/cannot be retried/);
    sermon.markFailed('MEDIA', 'Bad file', false);
    expect(() => sermon.retry()).toThrow(/cannot be retried/);
  });

  it('validates details', () => {
    const sermon = create();
    expect(() => sermon.updateDetails({ title: '  ' })).toThrow();
    expect(() =>
      sermon.updateDetails({ sermonDate: new Date('nope') }),
    ).toThrow();
    expect(() =>
      sermon.updateDetails({
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
    sermon.updateDetails({ series: '  ', mainScripture: 'John 3:16' });
    expect(sermon.snapshot()).toMatchObject({
      series: null,
      mainScripture: 'John 3:16',
    });
  });
});
