import { PurgeExpiredSourcesUseCase } from '../src/modules/sermons/application/use-cases/purge-expired-sources.use-case.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('sermon source retention (e2e)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.close());

  it('removes an expired original while keeping its transcript', async () => {
    const client = new Client(t);
    await client.onboard('Retention Church');
    const id = await client.readySermon('Short retention');
    const asset = [...t.infra.db.assets.values()].find(
      (row) => row.sermonId === id,
    );
    expect(asset?.expiresAt?.getTime()).toBe(
      t.infra.clock.now().getTime() + 3 * 86_400_000,
    );
    const purge = t.app.get(PurgeExpiredSourcesUseCase);
    expect(await purge.execute()).toBe(0);
    t.infra.clock.advance(3 * 86_400_000 + 1);
    expect(await purge.execute()).toBe(1);
    expect(await purge.execute()).toBe(0);
    expect(await t.infra.storage.headObject(asset?.objectKey ?? '')).toBeNull();
    await client.login();
    await client.get(`/sermons/${id}/transcript`).expect(200);
  });

  it('keeps an expired original while its sermon is still processing', async () => {
    const client = new Client(t);
    await client.onboard('Slow Church');
    const id = await client.createSermon('Still processing');
    t.infra.clock.advance(3 * 86_400_000 + 1);
    expect(await t.app.get(PurgeExpiredSourcesUseCase).execute()).toBe(0);
    const asset = [...t.infra.db.assets.values()].find(
      (row) => row.sermonId === id,
    );
    expect(asset?.deletedAt).toBeNull();
    expect(
      await t.infra.storage.headObject(asset?.objectKey ?? ''),
    ).not.toBeNull();
  });
});
