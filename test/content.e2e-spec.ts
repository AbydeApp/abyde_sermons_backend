import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('content lifecycle, versions and calendar rules (e2e)', () => {
  let t: TestApp;
  let client: Client;
  let sermonId: string;

  const firstOfType = async (type: string) =>
    (await client.get(`/content?sermonId=${sermonId}&type=${type}`).expect(200))
      .body.data[0];

  beforeAll(async () => {
    t = await createTestApp();
    client = new Client(t);
    await client.onboard('Content Church');
    sermonId = await client.readySermon();
    await client
      .post(`/sermons/${sermonId}/generate-week`, {
        contentTypes: ['DEVOTIONAL', 'SOCIAL_POST', 'QUOTE'],
      })
      .expect(202);
    await t.infra.queue.drain();
  });
  afterAll(() => t.close());

  it('editing scheduled content returns it to DRAFT and removes its calendar entry', async () => {
    const item = await firstOfType('SOCIAL_POST');
    await client.post(`/content/${item.id}/approve`).expect(200);
    const entry = await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-10T08:00:00Z',
      })
      .expect(201);
    const edited = await client
      .patch(`/content/${item.id}`, { title: 'New title' })
      .expect(200);
    expect(edited.body).toMatchObject({
      status: 'DRAFT',
      calendarItemId: null,
      scheduledAt: null,
    });
    await client.delete(`/calendar/${entry.body.id}`).expect(404);
  });

  it('rewrite and regenerate persist immediately as new versions; restore never deletes history', async () => {
    const item = await firstOfType('DEVOTIONAL');
    const rewritten = await client
      .post(`/content/${item.id}/rewrite`, { action: 'SHORTEN' })
      .expect(200);
    expect(rewritten.body.currentVersion).toBe(item.currentVersion + 1);
    const regenerated = await client
      .post(`/content/${item.id}/regenerate`)
      .expect(200);
    expect(regenerated.body.currentVersion).toBe(item.currentVersion + 2);
    const restored = await client
      .post(`/content/${item.id}/versions/1/restore`)
      .expect(200);
    expect(restored.body).toMatchObject({
      currentVersion: item.currentVersion + 3,
      body: item.body,
      title: item.title,
    });
    const versions = await client
      .get(`/content/${item.id}/versions`)
      .expect(200);
    expect(versions.body.map((v: { source: string }) => v.source)).toEqual([
      'USER_EDIT',
      'AI_GENERATED',
      'AI_REWRITE',
      'AI_GENERATED',
    ]);
    await client
      .post(`/content/${item.id}/rewrite`, { action: 'LOUDER' })
      .expect(422);
  });

  it('scheduling requires approval and a future time', async () => {
    const item = await firstOfType('DEVOTIONAL');
    const notApproved = await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-10T08:00:00Z',
      })
      .expect(422);
    expect(notApproved.body.code).toBe('CONTENT_NOT_APPROVED');
    await client.post(`/content/${item.id}/approve`).expect(200);
    const past = await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-01T08:00:00Z',
      })
      .expect(422);
    expect(past.body).toMatchObject({
      code: 'PAST_DATE',
      errors: { scheduledAt: [expect.any(String)] },
    });
    const entry = await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-10T08:00:00Z',
      })
      .expect(201);
    const moved = await client
      .patch(`/calendar/${entry.body.id}`, {
        scheduledAt: '2026-10-11T08:00:00Z',
      })
      .expect(200);
    expect(moved.body.scheduledAt).toBe('2026-10-11T08:00:00.000Z');
    // Scheduling the same item again moves its single entry rather than creating a duplicate.
    await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-12T08:00:00Z',
      })
      .expect(201);
    expect(
      [...t.infra.db.calendarItems.values()].filter(
        (e) => e.contentItemId === item.id,
      ),
    ).toHaveLength(1);
    await client.delete(`/calendar/${entry.body.id}`).expect(204);
    expect((await client.get(`/content/${item.id}`)).body).toMatchObject({
      status: 'APPROVED',
      calendarItemId: null,
    });
  });

  it('approving is idempotent and published content is read-only', async () => {
    const item = await firstOfType('QUOTE');
    await client.post(`/content/${item.id}/approve`).expect(200);
    await client.post(`/content/${item.id}/approve`).expect(200);
    const stored = t.infra.db.contentItems.get(item.id);
    if (stored) stored.status = 'PUBLISHED';
    const locked = await client
      .patch(`/content/${item.id}`, { body: 'changed' })
      .expect(422);
    expect(locked.body.code).toBe('CONTENT_LOCKED');
    await client
      .post(`/content/${item.id}/rewrite`, { action: 'WARMER' })
      .expect(422);
  });

  it("quotes stop being labelled as the pastor's exact words once edited, and regenerate to a different quote", async () => {
    const quotes = (
      await client.get(`/content?sermonId=${sermonId}&type=QUOTE`)
    ).body.data.filter((item: { status: string }) => item.status === 'DRAFT');
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = quotes;
    expect(first.source.verbatim).toBe(true);

    // Remove one quote, then regenerate another: it must become a quote that is not already on the list.
    await client.delete(`/content/${first.id}`).expect(204);
    const siblings = (
      await client.get(`/content?sermonId=${sermonId}&type=QUOTE`)
    ).body.data.map((item: { body: string }) => item.body);
    const regenerated = await client
      .post(`/content/${second.id}/regenerate`)
      .expect(200);
    expect(siblings).not.toContain(regenerated.body.body);
    expect(regenerated.body.source.verbatim).toBe(true);

    const edited = await client
      .patch(`/content/${second.id}`, { body: 'My own words about faith.' })
      .expect(200);
    expect(edited.body.source.verbatim).toBe(false);
    const rewrittenTitleOnly = await client
      .patch(`/content/${second.id}`, { title: 'Retitled' })
      .expect(200);
    expect(rewrittenTitleOnly.body.source.verbatim).toBe(false);
  });

  it('deleting content removes it and its calendar entry', async () => {
    const items = (
      await client.get(`/content?sermonId=${sermonId}&type=SOCIAL_POST`)
    ).body.data;
    const item = items[1];
    await client.post(`/content/${item.id}/approve`).expect(200);
    await client
      .post('/calendar', {
        contentItemId: item.id,
        scheduledAt: '2026-10-13T08:00:00Z',
      })
      .expect(201);
    await client.delete(`/content/${item.id}`).expect(204);
    await client.get(`/content/${item.id}`).expect(404);
    expect(
      [...t.infra.db.calendarItems.values()].some(
        (e) => e.contentItemId === item.id,
      ),
    ).toBe(false);
  });

  it('filters and searches content', async () => {
    const drafts = await client
      .get('/content?status=DRAFT&type=DEVOTIONAL&pageSize=50')
      .expect(200);
    expect(
      drafts.body.data.every(
        (item: { status: string; type: string }) =>
          item.status === 'DRAFT' && item.type === 'DEVOTIONAL',
      ),
    ).toBe(true);
    const search = await client.get('/content?q=Day%202').expect(200);
    expect(
      search.body.data.every((item: { title: string; body: string }) =>
        `${item.title} ${item.body}`.includes('Day 2'),
      ),
    ).toBe(true);
    await client.get('/content?status=NOPE').expect(422);
  });

  it('deleting a sermon removes its content and storage objects', async () => {
    const otherId = await client.readySermon('To Delete');
    await client
      .post(`/sermons/${otherId}/generate-week`, { contentTypes: ['PRAYER'] })
      .expect(202);
    await t.infra.queue.drain();
    const assetKey =
      [...t.infra.db.assets.values()].find(
        (asset) => asset.sermonId === otherId,
      )?.objectKey ?? '';
    expect(t.infra.storage.objects.has(assetKey)).toBe(true);
    await client.delete(`/sermons/${otherId}`).expect(204);
    await client.get(`/sermons/${otherId}`).expect(404);
    expect(
      (await client.get(`/content?sermonId=${otherId}`)).body.meta.total,
    ).toBe(0);
    expect(t.infra.storage.objects.has(assetKey)).toBe(false);
    expect(
      [...t.infra.db.embeddings.values()].some(
        (row) => row.sermonId === otherId,
      ),
    ).toBe(false);
  });
});
