import { GenerationService } from '../src/modules/content/generation.service.js';
import { SermonsService } from '../src/modules/sermons/sermons.service.js';
import { SystemService } from '../src/modules/system/system.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

/** Behaviour under interleavings and failures: deletes and edits during processing, lost jobs, queue outages. */
describe('resilience (e2e)', () => {
  let t: TestApp;
  let client: Client;

  beforeEach(async () => {
    t = await createTestApp();
    client = new Client(t);
    await client.onboard('Resilience Church');
  });
  afterEach(() => t.close());

  it('never resurrects a sermon deleted while its jobs are still queued', async () => {
    const id = await client.createSermon();
    await client.delete(`/sermons/${id}`).expect(204);
    await t.infra.queue.drain();
    await client.get(`/sermons/${id}`).expect(404);
    expect(t.infra.db.sermons.has(id)).toBe(false);
    expect(
      [...t.infra.db.segments.values()].some(
        (segment) => segment.sermonId === id,
      ),
    ).toBe(false);
    expect(
      [...t.infra.db.embeddings.values()].some((row) => row.sermonId === id),
    ).toBe(false);
  });

  it('keeps a user edit made while the sermon is processing', async () => {
    const id = await client.createSermon('Original Title');
    await client
      .patch(`/sermons/${id}`, {
        title: 'Edited While Processing',
        tags: ['hope'],
      })
      .expect(200);
    await t.infra.queue.drain();
    const sermon = await client.get(`/sermons/${id}`).expect(200);
    expect(sermon.body).toMatchObject({
      status: 'READY',
      title: 'Edited While Processing',
      tags: ['hope'],
    });
  });

  it('an edit that lands after processing finished does not regress the status', async () => {
    const id = await client.readySermon();
    const edited = await client
      .patch(`/sermons/${id}`, { series: 'New Series' })
      .expect(200);
    expect(edited.body).toMatchObject({
      status: 'READY',
      series: 'New Series',
      mainTheme: 'Walking by faith',
    });
  });

  it('marks a sermon whose job was lost as failed and retryable, then recovers on retry', async () => {
    const id = await client.createSermon();
    t.infra.queue.jobs.length = 0; // the queue lost the job (worker killed / Redis flushed)
    const recover = t.app.get(SermonsService);
    expect(await recover.recoverStuck()).toBe(0); // not stuck yet
    t.infra.clock.advance(2 * 3600 * 1000 + 1000);
    expect(await recover.recoverStuck()).toBe(1);
    expect(await recover.recoverStuck()).toBe(0); // idempotent
    await client.login();
    const failed = await client.get(`/sermons/${id}/status`).expect(200);
    expect(failed.body).toMatchObject({
      status: 'FAILED',
      failedStage: 'UPLOAD',
      canRetry: true,
      errorMessage: 'Processing was interrupted. Please try again.',
    });
    await client.post(`/sermons/${id}/status/retry`).expect(202);
    await t.infra.queue.drain();
    expect((await client.get(`/sermons/${id}/status`)).body.status).toBe(
      'READY',
    );
  });

  it('fails visibly (retryable) when the queue is unavailable at upload time', async () => {
    const original = t.infra.queue.enqueue.bind(t.infra.queue);
    t.infra.queue.enqueue = async () => {
      throw new Error('redis unavailable');
    };
    const id = await client.createSermon();
    t.infra.queue.enqueue = original;
    const status = await client.get(`/sermons/${id}/status`).expect(200);
    expect(status.body).toMatchObject({ status: 'FAILED', canRetry: true });
    await client.post(`/sermons/${id}/status/retry`).expect(202);
    await t.infra.queue.drain();
    expect((await client.get(`/sermons/${id}/status`)).body.status).toBe(
      'READY',
    );
  });

  it('fails generation jobs that were lost so the group completes and can be retried', async () => {
    const id = await client.readySermon();
    const group = await client
      .post(`/sermons/${id}/generate-week`, {
        contentTypes: ['PRAYER', 'EMAIL'],
      })
      .expect(202);
    t.infra.queue.jobs.length = 0;
    const recover = t.app.get(GenerationService);
    expect(await recover.recoverStuck()).toBe(0);
    t.infra.clock.advance(31 * 60 * 1000);
    expect(await recover.recoverStuck()).toBe(2);
    const stuck = await client
      .get(`/sermons/${id}/generations/${group.body.id}`)
      .expect(200);
    expect(stuck.body.done).toBe(true);
    expect(
      stuck.body.jobs.every(
        (job: { status: string; errorMessage: string }) =>
          job.status === 'FAILED' && job.errorMessage.includes('interrupted'),
      ),
    ).toBe(true);
    const retry = await client
      .post(`/sermons/${id}/generate-week`, {
        contentTypes: ['PRAYER', 'EMAIL'],
      })
      .expect(202);
    expect(retry.body.id).toBe(group.body.id);
    await t.infra.queue.drain();
    expect(
      (
        await client.get(`/sermons/${id}/generations/${group.body.id}`)
      ).body.jobs.every(
        (job: { status: string }) => job.status === 'COMPLETED',
      ),
    ).toBe(true);
  });

  it('refuses media that changed in storage after it was validated', async () => {
    const id = await client.createSermon();
    const key =
      [...t.infra.db.assets.values()].find((asset) => asset.sermonId === id)
        ?.objectKey ?? '';
    t.infra.storage.put(key, Buffer.alloc(50_000, 1), 'audio/mpeg');
    await t.infra.queue.drain();
    const status = await client.get(`/sermons/${id}/status`).expect(200);
    expect(status.body).toMatchObject({
      status: 'FAILED',
      failedStage: 'MEDIA',
      errorMessage: 'We could not read this file. Please upload it again.',
    });
  });

  it('purges long-expired sessions and reset tokens only', async () => {
    await client
      .post(
        '/auth/forgot-password',
        { email: client.email },
        { 'Idempotency-Key': 'test-key-resi-0001' },
      )
      .expect(204);
    await t.infra.queue.drain(); // the reset token is issued by a background job
    const purge = t.app.get(AuthService);
    expect(await purge.purgeExpired()).toEqual({ sessions: 0, resetTokens: 0 });
    t.infra.clock.advance(32 * 24 * 3600 * 1000);
    expect(await purge.purgeExpired()).toEqual({ sessions: 1, resetTokens: 1 });
    expect(t.infra.db.users.size).toBe(1);
  });

  it('caps AI edits per church per hour', async () => {
    const id = await client.readySermon();
    await client
      .post(`/sermons/${id}/generate-week`, { contentTypes: ['EMAIL'] })
      .expect(202);
    await t.infra.queue.drain();
    const item = (await client.get(`/content?sermonId=${id}&type=EMAIL`)).body
      .data[0];
    const churchId = [...t.infra.db.churches.keys()][0];
    for (let i = 0; i < 120; i++)
      await t.infra.cache.increment(`ai-budget:edit:${churchId}`, 3600);
    const blocked = await client
      .post(`/content/${item.id}/rewrite`, { action: 'SHORTEN' })
      .expect(429);
    expect(blocked.body.code).toBe('AI_LIMIT_REACHED');
    expect((await client.get(`/content/${item.id}`)).body.currentVersion).toBe(
      1,
    );
    // The in-flight guard was released, so the item is not left locked.
    t.infra.clock.advance(3601 * 1000);
    await client.login();
    await client
      .post(`/content/${item.id}/rewrite`, { action: 'SHORTEN' })
      .expect(200);
  });

  it('prunes old webhook records and AI cost logs, keeping recent ones', async () => {
    await client.readySermon();
    const purge = t.app.get(SystemService);
    const logs = t.infra.db.aiUsageLogs.length;
    expect(logs).toBeGreaterThan(0);
    t.infra.db.webhookEvents.set('fake:old', t.infra.clock.now());
    expect(await purge.purgeOldRecords()).toEqual({ webhookEvents: 0, aiUsageLogs: 0 });
    t.infra.clock.advance(91 * 24 * 3600 * 1000);
    t.infra.db.webhookEvents.set('fake:recent', t.infra.clock.now());
    expect(await purge.purgeOldRecords()).toEqual({ webhookEvents: 1, aiUsageLogs: 0 });
    expect([...t.infra.db.webhookEvents.keys()]).toEqual(['fake:recent']);
    t.infra.clock.advance(310 * 24 * 3600 * 1000);
    expect((await purge.purgeOldRecords()).aiUsageLogs).toBe(logs);
  });

  it('accepts a large document upload but refuses to parse it, with a clear message', async () => {
    const big = 3 * 1024 ** 3;
    await client
      .post('/uploads/presign', {
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
        sizeBytes: big,
        purpose: 'SERMON_MEDIA',
      })
      .expect(422);
    const size = 21 * 1024 ** 2; // over the 20 MB text parse limit, far under the 2 GB upload limit
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: size,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    t.infra.storage.put(
      presign.body.objectKey,
      Buffer.alloc(size, 'a'),
      'text/plain',
    );
    const created = await client
      .post('/sermons', {
        title: 'Huge notes',
        speaker: 'S',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey: presign.body.objectKey,
      })
      .expect(202);
    await t.infra.queue.drain();
    const status = await client
      .get(`/sermons/${created.body.id}/status`)
      .expect(200);
    expect(status.body).toMatchObject({
      status: 'FAILED',
      failedStage: 'MEDIA',
    });
    expect(status.body.errorMessage).toMatch(/too large to read/);
  });

  it('falls back to keyword search when the embedding provider is down', async () => {
    const id = await client.readySermon();
    t.infra.model.failures.add('embedding');
    const semantic = await client
      .post('/library/semantic-search', {
        query: 'walking by faith, not by sight',
      })
      .expect(200);
    expect(
      semantic.body.data.map((sermon: { id: string }) => sermon.id),
    ).toEqual([id]);
    const unrelated = await client
      .post('/library/semantic-search', {
        query: 'quantum chromodynamics renormalization',
      })
      .expect(200);
    expect(unrelated.body.data).toEqual([]);
  });

  it('Ask still shows the closest passages when the answer cannot be generated', async () => {
    await client.readySermon();
    t.infra.model.failures.add('grounded_answer');
    const answer = await client
      .post('/ask', {
        question: 'What did the pastor say about faith and trusting God?',
      })
      .expect(200);
    expect(answer.body.answer).toMatch(/closest matches/);
    expect(answer.body.sources.length).toBeGreaterThan(0);
    expect(answer.body.sources[0].sermonTitle).toBe('Walking By Faith');

    // With both the embedding and answer providers down, Ask still works from keyword matches.
    t.infra.model.failures.add('embedding');
    const degraded = await client
      .post('/ask', { question: 'faith trust obedience step' })
      .expect(200);
    expect(degraded.body.sources.length).toBeGreaterThan(0);
  });
});
