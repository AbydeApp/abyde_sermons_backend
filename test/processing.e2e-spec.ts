import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('sermon processing, failures and generation retries (e2e)', () => {
  let t: TestApp;
  let client: Client;

  beforeEach(async () => {
    t = await createTestApp();
    client = new Client(t);
    await client.onboard('Processing Church');
  });
  afterEach(() => t.close());

  it('validates the create request (exactly one source, verified upload)', async () => {
    const base = {
      title: 'T',
      speaker: 'S',
      sermonDate: '2026-09-27T09:00:00Z',
    };
    const neither = await client.post('/sermons', base).expect(422);
    expect(Object.keys(neither.body.errors)).toEqual(['objectKey']);
    await client
      .post('/sermons', {
        ...base,
        objectKey: 'x',
        transcriptText: 'y'.repeat(300),
      })
      .expect(422);
    await client
      .post('/sermons', { ...base, transcriptText: 'too short' })
      .expect(422);
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'a.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 10,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    const incomplete = await client
      .post('/sermons', { ...base, objectKey: presign.body.objectKey })
      .expect(422);
    expect(incomplete.body.code).toBe('UPLOAD_INCOMPLETE');
    await client
      .post('/uploads/presign', {
        fileName: 'a.exe',
        contentType: 'application/x-msdownload',
        sizeBytes: 10,
        purpose: 'SERMON_MEDIA',
      })
      .expect(422);
    await client
      .post('/uploads/presign', {
        fileName: 'a.mp4',
        contentType: 'audio/mpeg',
        sizeBytes: 10,
        purpose: 'SERMON_MEDIA',
      })
      .expect(422);
    await client
      .post('/uploads/presign', {
        fileName: 'a.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 3 * 1024 ** 3,
        purpose: 'SERMON_MEDIA',
      })
      .expect(422);
  });

  it('an upload can be attached to only one sermon', async () => {
    const id = await client.createSermon('First');
    const key = [...t.infra.db.assets.values()].find(
      (asset) => asset.sermonId === id,
    )?.objectKey;
    const reused = await client
      .post('/sermons', {
        title: 'Second',
        speaker: 'S',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey: key,
      })
      .expect(422);
    expect(reused.body.code).toBe('UPLOAD_ALREADY_USED');
  });

  it('processes a pasted transcript', async () => {
    const text =
      'Grace is the unearned favour of God. '.repeat(20) +
      'Read Ephesians 2:8 with me. '.repeat(3);
    const created = await client
      .post('/sermons', {
        title: 'Grace',
        speaker: 'S',
        sermonDate: '2026-09-27T09:00:00Z',
        transcriptText: text,
      })
      .expect(202);
    await t.infra.queue.drain();
    const sermon = await client.get(`/sermons/${created.body.id}`).expect(200);
    expect(sermon.body.status).toBe('READY');
    expect(sermon.body.scriptures).toContain('Ephesians 2:8');
  });

  it('marks the failed stage with a safe message, then resumes from it on retry', async () => {
    t.infra.model.failures.add('sermon_analysis');
    const id = await client.createSermon();
    await t.infra.queue.drain();
    const failed = await client.get(`/sermons/${id}/status`).expect(200);
    expect(failed.body).toEqual({
      sermonId: id,
      status: 'FAILED',
      processingStage: null,
      failedStage: 'UNDERSTAND',
      errorMessage: 'We could not analyse this sermon. Please try again.',
      canRetry: true,
    });
    const transcriptCount = [...t.infra.db.segments.values()].filter(
      (s) => s.sermonId === id,
    ).length;

    t.infra.model.failures.clear();
    const retried = await client
      .post(`/sermons/${id}/status/retry`)
      .expect(202);
    expect(retried.body).toMatchObject({
      status: 'QUEUED',
      processingStage: 'UNDERSTAND',
    });
    await t.infra.queue.drain();
    expect((await client.get(`/sermons/${id}/status`)).body.status).toBe(
      'READY',
    );
    // Transcription was not repeated: the same segments were reused.
    expect(
      [...t.infra.db.segments.values()].filter((s) => s.sermonId === id),
    ).toHaveLength(transcriptCount);
    await client.post(`/sermons/${id}/status/retry`).expect(409);
  });

  it('filters the sermon list by comma-separated statuses and query', async () => {
    const readyId = await client.readySermon('Ready One');
    const queuedId = await client.createSermon('Queued One');
    const processing = await client
      .get(
        '/sermons?status=UPLOADING,UPLOADED,QUEUED,TRANSCRIBING,ANALYZING,INDEXING',
      )
      .expect(200);
    expect(processing.body.data.map((s: { id: string }) => s.id)).toEqual([
      queuedId,
    ]);
    const ready = await client.get('/sermons?status=READY&q=ready').expect(200);
    expect(ready.body.data.map((s: { id: string }) => s.id)).toEqual([readyId]);
    expect(ready.body.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
    await client.get('/sermons?status=READY,BOGUS').expect(422);
  });

  it('generates content types independently and "retry failed" never duplicates completed work', async () => {
    const id = await client.readySermon();
    t.infra.model.failures.add('quote_batch');
    // Remove intelligence quotes so QUOTE generation must call the (failing) model.
    for (const row of t.infra.db.intelligence.values()) row.data.quotes = [];
    const group = await client
      .post(`/sermons/${id}/generate-week`, {
        contentTypes: ['DEVOTIONAL', 'QUOTE'],
      })
      .expect(202);
    await t.infra.queue.drain();
    const afterFailure = await client
      .get(`/sermons/${id}/generations/${group.body.id}`)
      .expect(200);
    expect(afterFailure.body).toMatchObject({
      done: true,
      jobs: [
        { contentType: 'DEVOTIONAL', status: 'COMPLETED', errorMessage: null },
        {
          contentType: 'QUOTE',
          status: 'FAILED',
          errorMessage: 'The model returned invalid output.',
        },
      ],
    });
    const devotionalCount = (
      await client.get(`/content?sermonId=${id}&type=DEVOTIONAL`)
    ).body.meta.total;

    t.infra.model.failures.clear();
    const retry = await client
      .post(`/sermons/${id}/generate-week`, { contentTypes: ['QUOTE'] })
      .expect(202);
    expect(retry.body.id).toBe(group.body.id);
    expect(
      retry.body.jobs.find(
        (job: { contentType: string }) => job.contentType === 'DEVOTIONAL',
      ).status,
    ).toBe('COMPLETED');
    await t.infra.queue.drain();
    const recovered = await client
      .get(`/sermons/${id}/generations/${group.body.id}`)
      .expect(200);
    expect(
      recovered.body.jobs.map((job: { status: string }) => job.status),
    ).toEqual(['COMPLETED', 'COMPLETED']);
    expect(
      (await client.get(`/content?sermonId=${id}&type=DEVOTIONAL`)).body.meta
        .total,
    ).toBe(devotionalCount);

    // Asking again for completed types starts a fresh group.
    const fresh = await client
      .post(`/sermons/${id}/generate-week`, { contentTypes: ['DEVOTIONAL'] })
      .expect(202);
    expect(fresh.body.id).not.toBe(group.body.id);
  });

  it('refuses to generate from a sermon that is not READY', async () => {
    const id = await client.createSermon();
    const response = await client
      .post(`/sermons/${id}/generate-week`, { contentTypes: ['DEVOTIONAL'] })
      .expect(409);
    expect(response.body.code).toBe('NOT_READY');
    await client
      .post(`/sermons/${id}/generate-week`, { contentTypes: [] })
      .expect(422);
  });

  it('answers from the archive with sources, and admits when there is no evidence', async () => {
    await client.readySermon();
    const grounded = await client
      .post('/ask', {
        question: 'What did the pastor say about faith and trusting God?',
      })
      .expect(200);
    expect(grounded.body.sources.length).toBeGreaterThan(0);
    expect(grounded.body.sources[0]).toEqual({
      sermonId: expect.any(String),
      sermonTitle: 'Walking By Faith',
      segmentId: expect.any(String),
      startTimeMs: expect.any(Number),
      endTimeMs: expect.any(Number),
      excerpt: expect.any(String),
    });
    const unknown = await client
      .post('/ask', {
        question: 'Quantum chromodynamics lattice gauge renormalization?',
      })
      .expect(200);
    expect(unknown.body.sources).toEqual([]);
    expect(unknown.body.answer).toMatch(/couldn't find/);
  });

  it('serves library search, semantic search and facets for READY sermons only', async () => {
    const readyId = await client.readySermon();
    await client.createSermon('Still Processing');
    const facets = await client.get('/library/facets').expect(200);
    expect(facets.body).toMatchObject({
      speakers: ['Pastor Ade'],
      years: ['2026'],
    });
    expect(facets.body.scriptures).toContain('Hebrews 11:1');
    const filtered = await client
      .post('/library/search', { scripture: 'Hebrews 11:1', year: 2026 })
      .expect(200);
    expect(filtered.body.data.map((s: { id: string }) => s.id)).toEqual([
      readyId,
    ]);
    const semantic = await client
      .post('/library/semantic-search', {
        query: 'walking by faith not by sight',
        speaker: 'Pastor Ade',
      })
      .expect(200);
    expect(semantic.body.data.map((s: { id: string }) => s.id)).toEqual([
      readyId,
    ]);
  });
});
