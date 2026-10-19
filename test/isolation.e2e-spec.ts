import { Client, createTestApp, type TestApp } from './support/test-app.js';

/**
 * Mandatory cross-church isolation tests (spec §39). Church A must never read, change or discover
 * Church B's data. Foreign resources are indistinguishable from missing ones (404, never 403).
 */
describe('cross-church isolation (e2e)', () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  let bSermonId: string;
  let bContentId: string;
  let bCalendarId: string;
  let bChurchId: string;

  beforeAll(async () => {
    t = await createTestApp();
    a = new Client(t);
    b = new Client(t);
    await a.onboard('Church A');
    bChurchId = await b.onboard('Church B');

    await a.readySermon('Hope In The Storm');
    bSermonId = await b.readySermon('Walking By Faith');
    const group = await b
      .post(`/sermons/${bSermonId}/generate-week`, {
        contentTypes: ['DEVOTIONAL'],
      })
      .expect(202);
    await t.infra.queue.drain();
    expect(
      (await b.get(`/sermons/${bSermonId}/generations/${group.body.id}`)).body
        .done,
    ).toBe(true);
    const content = await b.get(`/content?sermonId=${bSermonId}`).expect(200);
    bContentId = content.body.data[0].id;
    await b.post(`/content/${bContentId}/approve`).expect(200);
    bCalendarId = (
      await b
        .post('/calendar', {
          contentItemId: bContentId,
          scheduledAt: '2026-10-09T06:00:00Z',
        })
        .expect(201)
    ).body.id;
    await b.post('/integrations/email/connect').expect(200);
  });
  afterAll(() => t.close());

  it('Church A cannot fetch Church B sermon', async () => {
    for (const path of [
      `/sermons/${bSermonId}`,
      `/sermons/${bSermonId}/status`,
      `/sermons/${bSermonId}/transcript`,
      `/sermons/${bSermonId}/intelligence`,
    ]) {
      const response = await a.get(path).expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    }
    const list = await a.get('/sermons').expect(200);
    expect(
      list.body.data.map((sermon: { id: string }) => sermon.id),
    ).not.toContain(bSermonId);
  });

  it('Church A cannot modify Church B sermon', async () => {
    await a.patch(`/sermons/${bSermonId}`, { title: 'Hijacked' }).expect(404);
    await a.post(`/sermons/${bSermonId}/status/retry`).expect(404);
    await a
      .post(`/sermons/${bSermonId}/generate-week`, { contentTypes: ['PRAYER'] })
      .expect(404);
    await a.delete(`/sermons/${bSermonId}`).expect(404);
    const own = await b.get(`/sermons/${bSermonId}`).expect(200);
    expect(own.body.title).toBe('Walking By Faith');
  });

  it('Church A cannot fetch or change Church B content', async () => {
    await a.get(`/content/${bContentId}`).expect(404);
    await a.get(`/content/${bContentId}/versions`).expect(404);
    await a.patch(`/content/${bContentId}`, { body: 'hijack' }).expect(404);
    await a.post(`/content/${bContentId}/approve`).expect(404);
    await a
      .post(`/content/${bContentId}/rewrite`, { action: 'SHORTEN' })
      .expect(404);
    await a.post(`/content/${bContentId}/regenerate`).expect(404);
    await a.post(`/content/${bContentId}/versions/1/restore`).expect(404);
    await a.delete(`/content/${bContentId}`).expect(404);
    const listed = await a.get(`/content?sermonId=${bSermonId}`).expect(200);
    expect(listed.body.meta.total).toBe(0);
  });

  it('Church A cannot search Church B embeddings', async () => {
    const semantic = await a
      .post('/library/semantic-search', {
        query: 'walking by faith and not by sight',
      })
      .expect(200);
    expect(
      semantic.body.data.map((sermon: { id: string }) => sermon.id),
    ).not.toContain(bSermonId);
    const filtered = await a
      .post('/library/search', { speaker: 'Pastor Ade' })
      .expect(200);
    expect(
      filtered.body.data.map((sermon: { id: string }) => sermon.id),
    ).not.toContain(bSermonId);
    const answer = await a
      .post('/ask', { question: 'What did we teach about walking by faith?' })
      .expect(200);
    expect(
      answer.body.sources.map(
        (source: { sermonId: string }) => source.sermonId,
      ),
    ).not.toContain(bSermonId);
    const facets = await a.get('/library/facets').expect(200);
    expect(JSON.stringify(facets.body)).not.toContain('Walking By Faith');
  });

  it('Church A cannot access Church B storage asset', async () => {
    const bKey = [...t.infra.db.assets.values()].find(
      (asset) => asset.churchId === bChurchId,
    )?.objectKey;
    expect(bKey).toBeDefined();
    const attempt = await a
      .post('/sermons', {
        title: 'Stolen',
        speaker: 'X',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey: bKey,
      })
      .expect(422);
    expect(attempt.body.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('Church A cannot access Church B calendar item', async () => {
    const range = await a
      .get('/calendar?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z')
      .expect(200);
    expect(range.body).toEqual([]);
    await a
      .patch(`/calendar/${bCalendarId}`, {
        scheduledAt: '2026-10-10T06:00:00Z',
      })
      .expect(404);
    await a.delete(`/calendar/${bCalendarId}`).expect(404);
    await a
      .post('/calendar', {
        contentItemId: bContentId,
        scheduledAt: '2026-10-10T06:00:00Z',
      })
      .expect(404);
    const own = await b
      .get('/calendar?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z')
      .expect(200);
    expect(own.body).toHaveLength(1);
  });

  it('Church A cannot access Church B integration', async () => {
    const connect = await b.post('/integrations/email/connect').expect(200);
    const state = new URL(connect.body.authorizationUrl).searchParams.get(
      'state',
    );
    // B's authorisation link completed by A (or by nobody signed in) connects nothing: the
    // completion must come from the church that started the flow.
    const hijack = await a
      .post('/integrations/email/complete', { code: 'abc', state })
      .expect(422);
    expect(hijack.body.code).toBe('INVALID_OAUTH_STATE');
    await new Client(t)
      .post('/integrations/email/complete', { code: 'abc', state })
      .expect(401);
    for (const client of [a, b]) {
      const rows = await client.get('/integrations').expect(200);
      expect(
        rows.body.find((row: { provider: string }) => row.provider === 'EMAIL')
          .status,
      ).toBe('NOT_CONNECTED');
    }
    // B completes its own flow.
    const ownState = new URL(
      (await b.post('/integrations/email/connect').expect(200)).body
        .authorizationUrl,
    ).searchParams.get('state');
    await b
      .post('/integrations/email/complete', { code: 'abc', state: ownState })
      .expect(200);
    const aIntegrations = await a.get('/integrations').expect(200);
    expect(
      aIntegrations.body.find(
        (row: { provider: string }) => row.provider === 'EMAIL',
      ).status,
    ).toBe('NOT_CONNECTED');
    const bIntegrations = await b.get('/integrations').expect(200);
    expect(
      bIntegrations.body.find(
        (row: { provider: string }) => row.provider === 'EMAIL',
      ).status,
    ).toBe('CONNECTED');
    await a.delete('/integrations/email').expect(204);
    const stillConnected = await b.get('/integrations').expect(200);
    expect(
      stillConnected.body.find(
        (row: { provider: string }) => row.provider === 'EMAIL',
      ).status,
    ).toBe('CONNECTED');
    expect(JSON.stringify(bIntegrations.body)).not.toMatch(/token|credential/i);
  });

  it('Church A cannot see Church B usage, generations or analytics', async () => {
    const group = [...t.infra.db.generationGroups.values()].find(
      (g) => g.sermonId === bSermonId,
    );
    await a.get(`/sermons/${bSermonId}/generations/${group?.id}`).expect(404);
    const analytics = await a.get('/analytics').expect(200);
    expect(analytics.body).toMatchObject({
      sermonsUploaded: 1,
      contentGenerated: 0,
      contentScheduled: 0,
    });
    const usage = await a.get('/billing/usage').expect(200);
    expect(usage.body.sermonsUsed).toBe(1);
  });

  it('ignores any churchId supplied by the client', async () => {
    const created = await a
      .post('/sermons', {
        title: 'Mine',
        speaker: 'A',
        sermonDate: '2026-09-27T09:00:00Z',
        transcriptText: 'Faith and hope. '.repeat(30),
        churchId: bChurchId,
      })
      .expect(202);
    expect(t.infra.db.sermons.get(created.body.id)?.churchId).not.toBe(
      bChurchId,
    );
  });
});
