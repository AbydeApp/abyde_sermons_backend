import { DispatchDuePublicationsUseCase } from '../src/modules/publishing/application/use-cases/publishing.use-cases.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('publishing and integrations (e2e)', () => {
  let t: TestApp;
  let client: Client;
  let sermonId: string;

  const approveAndSchedule = async (
    type: string,
    index: number,
    at: string,
  ) => {
    const item = (
      await client.get(`/content?sermonId=${sermonId}&type=${type}`)
    ).body.data[index];
    await client.post(`/content/${item.id}/approve`).expect(200);
    await client
      .post('/calendar', { contentItemId: item.id, scheduledAt: at })
      .expect(201);
    return item.id as string;
  };
  const dispatch = () => t.app.get(DispatchDuePublicationsUseCase).execute();

  beforeAll(async () => {
    t = await createTestApp();
    client = new Client(t);
    await client.onboard('Publishing Church');
    sermonId = await client.readySermon();
    await client
      .post(`/sermons/${sermonId}/generate-week`, {
        contentTypes: ['SOCIAL_POST', 'EMAIL', 'WHATSAPP'],
      })
      .expect(202);
    await t.infra.queue.drain();
  });
  afterAll(() => t.close());

  it('lists one row per provider and never exposes secrets', async () => {
    const list = await client.get('/integrations').expect(200);
    expect(list.body).toEqual([
      { provider: 'META', status: 'NOT_CONNECTED', accountLabel: null },
      { provider: 'WHATSAPP', status: 'NOT_CONNECTED', accountLabel: null },
      { provider: 'EMAIL', status: 'NOT_CONNECTED', accountLabel: null },
      { provider: 'YOUTUBE', status: 'NOT_CONNECTED', accountLabel: null },
    ]);
    const unavailable = await client
      .post('/integrations/youtube/connect')
      .expect(503);
    expect(unavailable.body.code).toBe('INTEGRATION_UNAVAILABLE');
    await client.post('/integrations/myspace/connect').expect(404);
  });

  it('fails visibly (without posting) when the channel is not connected', async () => {
    const itemId = await approveAndSchedule(
      'SOCIAL_POST',
      0,
      '2026-10-05T10:00:00Z',
    );
    t.infra.clock.set('2026-10-05T10:01:00Z');
    expect(await dispatch()).toBe(1);
    await t.infra.queue.drain();
    expect((await client.get(`/content/${itemId}`)).body.status).toBe('FAILED');
    expect(t.infra.metaPublisher.published).toHaveLength(0);

    // Re-approving after a failed publish clears the stale calendar entry, so it can be scheduled again.
    const reapproved = await client
      .post(`/content/${itemId}/approve`)
      .expect(200);
    expect(reapproved.body).toMatchObject({
      status: 'APPROVED',
      calendarItemId: null,
      scheduledAt: null,
    });
    const ready = await client
      .get('/content?status=APPROVED&scheduled=false')
      .expect(200);
    expect(ready.body.data.map((item: { id: string }) => item.id)).toContain(
      itemId,
    );
  });

  it('connects via OAuth with single-use state and stores encrypted credentials', async () => {
    t.infra.clock.set('2026-10-05T09:00:00Z');
    const connect = await client.post('/integrations/meta/connect').expect(200);
    const state =
      new URL(connect.body.authorizationUrl).searchParams.get('state') ?? '';
    const callback = await client
      .get(`/integrations/meta/callback?code=good-code&state=${state}`)
      .expect(302);
    expect(callback.headers.location).toBe(
      'http://web.test/integrations?connected=META',
    );
    const replay = await client
      .get(`/integrations/meta/callback?code=good-code&state=${state}`)
      .expect(302);
    expect(replay.headers.location).toBe(
      'http://web.test/integrations?error=invalid_state',
    );
    const stored = t.infra.db.integrations.values().next().value;
    expect(stored?.encryptedCredentials).toMatch(/^v1\./);
    expect(stored?.encryptedCredentials).not.toContain('good-code');
    const list = await client.get('/integrations').expect(200);
    expect(list.body[0]).toEqual({
      provider: 'META',
      status: 'CONNECTED',
      accountLabel: 'META account',
    });
  });

  it('publishes due items exactly once, even if dispatched or processed twice', async () => {
    const itemId = await approveAndSchedule(
      'SOCIAL_POST',
      1,
      '2026-10-05T12:00:00Z',
    );
    t.infra.clock.set('2026-10-05T11:59:00Z');
    expect(await dispatch()).toBe(0);
    t.infra.clock.set('2026-10-05T12:00:30Z');
    expect(await dispatch()).toBe(1);
    expect(await dispatch()).toBe(0); // already claimed
    await t.infra.queue.drain();
    const published = await client.get(`/content/${itemId}`).expect(200);
    expect(published.body.status).toBe('PUBLISHED');
    expect(published.body.publishedAt).toBe('2026-10-05T12:00:30.000Z');
    expect(t.infra.metaPublisher.published).toHaveLength(1);
    expect(
      t.infra.metaPublisher.published[0]?.credentials.pageAccessToken,
    ).toBe('token-good-code');

    // Re-running the same publish job (e.g. a duplicate delivery) must not post again.
    const job = t.infra.queue.jobs.find(
      (j) =>
        j.name === 'publish' &&
        (j.payload as { contentItemId: string }).contentItemId === itemId,
    );
    if (job) job.state = 'waiting';
    await t.infra.queue.drain();
    expect(t.infra.metaPublisher.published).toHaveLength(1);
    await client
      .patch(`/content/${itemId}`, { body: 'edit after publishing' })
      .expect(422);
  });

  it('leaves manually-shared types (WhatsApp) on the calendar as a plan', async () => {
    const itemId = await approveAndSchedule(
      'WHATSAPP',
      0,
      '2026-10-05T14:00:00Z',
    );
    t.infra.clock.set('2026-10-05T14:05:00Z');
    expect(await dispatch()).toBe(0);
    expect((await client.get(`/content/${itemId}`)).body.status).toBe(
      'SCHEDULED',
    );
  });

  it('disconnects idempotently', async () => {
    await client.delete('/integrations/meta').expect(204);
    await client.delete('/integrations/meta').expect(204);
    expect((await client.get('/integrations')).body[0].status).toBe(
      'NOT_CONNECTED',
    );
  });
});
