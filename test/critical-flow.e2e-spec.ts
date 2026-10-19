import { Client, createTestApp, type TestApp } from './support/test-app.js';

/**
 * Critical backend E2E (spec §47): Register (creates the church) → Verify email → Request Upload URL → Create Sermon →
 * Queue Processing → Transcription (mocked) → Analysis (mocked) → Embeddings → READY → Generate Week →
 * Persist Content → Edit → Approve → Schedule.
 */
describe('critical sermon-to-calendar flow (e2e)', () => {
  let t: TestApp;
  let client: Client;

  beforeAll(async () => {
    t = await createTestApp();
    client = new Client(t);
  });
  afterAll(() => t.close());

  it('omits reels endpoints and background jobs from v1', async () => {
    const church = new Client(t);
    await church.onboard('V1 Church');
    const sermonId = await church.readySermon();
    await church.get('/reels').expect(404);
    await church.post('/reels', { sermonId }).expect(404);
    await church.get(`/sermons/${sermonId}/reel-candidates`).expect(404);
    await church.post(`/sermons/${sermonId}/reel-candidates`).expect(404);
    expect(t.infra.registry.queues()).not.toContain('reel-candidates');
    expect(t.infra.registry.queues()).not.toContain('reel-render');
    expect(
      t.infra.queue.jobs.some((job) => job.queue.startsWith('reel-')),
    ).toBe(false);
  });

  it('runs the MVP loop end to end', async () => {
    client.email = 'ade@example.com';
    const register = await client
      .post('/auth/register', {
        fullName: 'Pastor Ade',
        email: 'Ade@Example.com',
        password: 'Faith2026!',
        churchName: 'Grace Community Church',
      })
      .expect(201);
    // No session until the emailed code is confirmed.
    expect(register.body).toEqual({ email: 'ade@example.com' });
    await client.get('/sermons').expect(401);

    const onboarded = await client.verifyEmail();
    expect(onboarded.body).toMatchObject({
      authenticated: true,
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(Number),
      user: { email: 'ade@example.com' },
      church: {
        name: 'Grace Community Church',
        slug: 'grace-community-church',
        preferredBibleTranslation: 'NIV',
      },
    });
    expect(onboarded.body.church).not.toHaveProperty('userId');

    const audio = Buffer.from('sermon-audio');
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'sunday.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: audio.length,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    expect(presign.body).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
    });
    expect(presign.body.objectKey).toMatch(
      new RegExp(
        `^churches/${onboarded.body.church.id}/sermons/[0-9a-f-]+\\.mp3$`,
      ),
    );
    t.infra.storage.put(presign.body.objectKey, audio, 'audio/mpeg');

    const created = await client
      .post('/sermons', {
        title: 'Walking By Faith',
        speaker: 'Pastor Ade',
        sermonDate: '2026-09-27T09:00:00Z',
        series: 'Trust',
        mainScripture: '2 Corinthians 5:7',
        tags: ['Faith'],
        objectKey: presign.body.objectKey,
      })
      .expect(202);
    const sermonId = created.body.id as string;

    const queued = await client.get(`/sermons/${sermonId}/status`).expect(200);
    expect(queued.body).toEqual({
      sermonId,
      status: 'QUEUED',
      processingStage: 'UPLOAD',
      failedStage: null,
      errorMessage: null,
      canRetry: false,
    });
    await client.get(`/sermons/${sermonId}/transcript`).expect(409);

    await t.infra.queue.drain();

    const ready = await client.get(`/sermons/${sermonId}/status`).expect(200);
    expect(ready.body).toMatchObject({
      status: 'READY',
      processingStage: null,
    });

    const sermon = await client.get(`/sermons/${sermonId}`).expect(200);
    expect(sermon.body).toMatchObject({
      title: 'Walking By Faith',
      status: 'READY',
      tags: ['faith'],
      mainTheme: 'Walking by faith',
    });
    expect(sermon.body.scriptures).toEqual(
      expect.arrayContaining([
        '2 Corinthians 5:7',
        'Hebrews 11:1',
        'Romans 8:28',
      ]),
    );

    const transcript = await client
      .get(`/sermons/${sermonId}/transcript`)
      .expect(200);
    expect(transcript.body.length).toBeGreaterThan(0);
    expect(transcript.body[0]).toMatchObject({
      sequence: 1,
      startTimeMs: 0,
      speakerLabel: null,
    });

    const intelligence = await client
      .get(`/sermons/${sermonId}/intelligence`)
      .expect(200);
    expect(intelligence.body.themes[0]).toMatchObject({
      text: 'Walking by faith',
    });
    const segmentIds = new Set(
      transcript.body.map((segment: { id: string }) => segment.id),
    );
    for (const item of [
      ...intelligence.body.themes,
      ...intelligence.body.quotes,
    ]) {
      if (item.sourceSegmentId)
        expect(segmentIds.has(item.sourceSegmentId)).toBe(true);
    }

    const allTypes = [
      'DEVOTIONAL',
      'SOCIAL_POST',
      'PRAYER',
      'BIBLE_STUDY',
      'EMAIL',
      'WHATSAPP',
      'QUOTE',
      'VIDEO_IDEA',
    ];
    const group = await client
      .post(`/sermons/${sermonId}/generate-week`, { contentTypes: allTypes })
      .expect(202);
    expect(group.body.done).toBe(false);
    expect(
      group.body.jobs.map((job: { status: string }) => job.status),
    ).toEqual(Array(8).fill('QUEUED'));

    await t.infra.queue.drain();
    const finished = await client
      .get(`/sermons/${sermonId}/generations/${group.body.id}`)
      .expect(200);
    expect(finished.body.done).toBe(true);
    expect(
      finished.body.jobs.every(
        (job: { status: string }) => job.status === 'COMPLETED',
      ),
    ).toBe(true);

    const devotionals = await client
      .get(`/content?sermonId=${sermonId}&type=DEVOTIONAL`)
      .expect(200);
    expect(devotionals.body.meta.total).toBe(7);
    const devotional = devotionals.body.data.find((item: { title: string }) =>
      item.title.startsWith('Day 1'),
    );
    expect(devotional).toMatchObject({
      status: 'DRAFT',
      currentVersion: 1,
      sermonTitle: 'Walking By Faith',
      calendarItemId: null,
      source: { verbatim: false },
    });
    expect(devotional.source.segments.length).toBeGreaterThan(0);

    const quotes = await client
      .get(`/content?sermonId=${sermonId}&type=QUOTE`)
      .expect(200);
    expect(quotes.body.data.length).toBeGreaterThan(0);
    for (const quote of quotes.body.data)
      expect(quote.source.verbatim).toBe(true);

    const edited = await client
      .patch(`/content/${devotional.id}`, {
        body: 'An edited devotional body.',
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      currentVersion: 2,
      status: 'DRAFT',
      body: 'An edited devotional body.',
    });

    await client
      .post('/calendar', {
        contentItemId: devotional.id,
        scheduledAt: '2026-10-08T06:00:00Z',
      })
      .expect(422);

    const approved = await client
      .post(`/content/${devotional.id}/approve`)
      .expect(200);
    expect(approved.body.status).toBe('APPROVED');

    const readyToSchedule = await client
      .get('/content?status=APPROVED&scheduled=false')
      .expect(200);
    expect(
      readyToSchedule.body.data.map((item: { id: string }) => item.id),
    ).toContain(devotional.id);

    const scheduled = await client
      .post('/calendar', {
        contentItemId: devotional.id,
        scheduledAt: '2026-10-08T06:00:00Z',
      })
      .expect(201);
    expect(scheduled.body).toMatchObject({
      status: 'SCHEDULED',
      scheduledAt: '2026-10-08T06:00:00.000Z',
      content: {
        id: devotional.id,
        status: 'SCHEDULED',
        sermonTitle: 'Walking By Faith',
      },
    });

    const calendar = await client
      .get('/calendar?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z')
      .expect(200);
    expect(calendar.body).toHaveLength(1);

    const versions = await client
      .get(`/content/${devotional.id}/versions`)
      .expect(200);
    expect(
      versions.body.map((v: { version: number; source: string }) => [
        v.version,
        v.source,
      ]),
    ).toEqual([
      [2, 'USER_EDIT'],
      [1, 'AI_GENERATED'],
    ]);
    expect(versions.body[1]).toMatchObject({
      aiProvider: 'fake',
      aiModel: 'fake-1',
    });
    expect(versions.body[0]).toMatchObject({ aiProvider: null, aiModel: null });

    const dashboard = await client.get('/dashboard').expect(200);
    expect(dashboard.body).toMatchObject({
      sermonsThisMonth: 1,
      scheduled: 1,
      published: 0,
      latestSermon: { id: sermonId },
    });

    const usage = await client.get('/billing/usage').expect(200);
    expect(usage.body).toMatchObject({ sermonsUsed: 1, sermonsLimit: 15 });
    expect(usage.body.contentGenerated).toBe(
      finished.body.jobs.length > 0
        ? (await client.get(`/content?sermonId=${sermonId}&pageSize=100`)).body
            .meta.total
        : 0,
    );

    // Every AI call left a cost log entry without storing prompts or responses.
    expect(t.infra.db.aiUsageLogs.length).toBeGreaterThan(0);
    for (const log of t.infra.db.aiUsageLogs) {
      expect(Object.keys(log).sort()).toEqual(
        [
          'churchId',
          'createdAt',
          'estimatedCost',
          'inputTokens',
          'latencyMs',
          'model',
          'operation',
          'outputTokens',
          'provider',
          'sermonId',
          'status',
        ].sort(),
      );
    }
  });
});
