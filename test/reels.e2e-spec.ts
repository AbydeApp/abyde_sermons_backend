import request from 'supertest';
import { FakePaymentAdapter } from '../src/modules/billing/infrastructure/providers/fake-payment.adapter.js';
import { RecoverStuckReelsUseCase } from '../src/modules/reels/application/use-cases/reel-render.use-cases.js';
import { PurgeExpiredSourcesUseCase } from '../src/modules/sermons/application/use-cases/purge-expired-sources.use-case.js';
import { PermanentJobError } from '../src/shared/application/jobs.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

/**
 * Reels end to end over in-memory infrastructure: candidates after processing, AI hooks, plan
 * limits, renders (fake encoder, real pipeline), approval, publishing, retention and isolation.
 */
describe('reels (e2e)', () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  let churchA: string;
  let sermonId: string;

  const key = () => ({
    'Idempotency-Key': `key-${Math.random().toString(36).slice(2, 12)}`,
  });

  const subscribe = (churchId: string, planId: string, eventId: string) => {
    const raw = JSON.stringify({
      id: eventId,
      type: 'charge.success',
      kind: 'PAYMENT_SUCCEEDED',
      amountKobo: planId === 'ministry' ? 5_000_000 : 2_500_000,
      currency: 'NGN',
      churchId,
      customerCode: `CUS_${eventId}`,
      planId,
      subscriptionCode: `SUB_${eventId}`,
      nextPaymentDate: '2026-11-05T09:00:00.000Z',
    });
    return request(t.app.getHttpServer())
      .post('/api/v1/webhooks/billing/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', FakePaymentAdapter.sign(raw))
      .send(raw)
      .expect(200);
  };

  /** Uploads a video sermon through the presign flow and processes it to READY. */
  const videoSermon = async (client: Client, title = 'Walking By Faith') => {
    const bytes = Buffer.from('fake-mp4-bytes');
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'sermon.mp4',
        contentType: 'video/mp4',
        sizeBytes: bytes.length,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    const { objectKey } = presign.body as { objectKey: string };
    t.infra.storage.put(objectKey, bytes, 'video/mp4');
    const created = await client
      .post('/sermons', {
        title,
        speaker: 'Pastor Ade',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey,
      })
      .expect(202);
    await t.infra.queue.drain();
    return (created.body as { id: string }).id;
  };

  const reel = async (client: Client, id: string) =>
    (await client.get(`/reels/${id}`).expect(200)).body;

  const reelFromCandidate = async (
    client: Client,
    sermon = sermonId,
    index = 0,
  ) => {
    const list = await client
      .get(`/sermons/${sermon}/reel-candidates`)
      .expect(200);
    const created = await client
      .post('/reels', { candidateId: list.body.items[index].id })
      .expect(201);
    return created.body as { id: string } & Record<string, unknown>;
  };

  const renderJobs = () =>
    t.infra.queue.jobs.filter((job) => job.queue === 'reel-render');

  beforeAll(async () => {
    t = await createTestApp();
    a = new Client(t);
    b = new Client(t);
    churchA = await a.onboard('Grace Chapel');
    await b.onboard('Other Church');
    sermonId = await videoSermon(a);
  });
  afterAll(() => t.close());

  describe('word timings and candidates', () => {
    it('stores word-level timings with the transcript', () => {
      const segments = [...t.infra.db.segments.values()].filter(
        (segment) => segment.sermonId === sermonId,
      );
      expect(segments.length).toBeGreaterThan(0);
      expect(
        segments.every((segment) => (segment.words?.length ?? 0) > 0),
      ).toBe(true);
    });

    it('selects 5–10 standalone moments automatically once the sermon is ready', async () => {
      const list = await a
        .get(`/sermons/${sermonId}/reel-candidates`)
        .expect(200);
      expect(list.body.renderable).toBe(true);
      const items = list.body.items as Array<Record<string, number | string>>;
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.length).toBeLessThanOrEqual(10);
      expect(items.map((item) => item.rank)).toEqual(
        items.map((_, i) => i + 1),
      );
      for (const item of items) {
        expect(item.durationMs).toBeGreaterThanOrEqual(15_000);
        expect(item.durationMs).toBeLessThanOrEqual(90_000);
        expect(typeof item.transcript).toBe('string');
      }
      // Best first, never overlapping.
      const scores = items.map((item) => item.score as number);
      expect([...scores].sort((x, y) => y - x)).toEqual(scores);
      const windows = [...items].sort(
        (x, y) => (x.startMs as number) - (y.startMs as number),
      );
      for (let i = 1; i < windows.length; i++)
        expect(windows[i]?.startMs).toBeGreaterThanOrEqual(
          windows[i - 1]?.endMs as number,
        );
    });

    it('does not regenerate candidates for an automatic duplicate job', async () => {
      const before = (await a.get(`/sermons/${sermonId}/reel-candidates`)).body
        .items;
      t.infra.queue.jobs.length = 0;
      await t.infra.queue.enqueue('reel-candidates', 'generate', {
        churchId: churchA,
        sermonId,
        attempt: 1,
      });
      await t.infra.queue.drain();
      expect(
        (await a.get(`/sermons/${sermonId}/reel-candidates`)).body.items,
      ).toEqual(before);
    });

    it('regenerates on request, in the background', async () => {
      const before = (await a.get(`/sermons/${sermonId}/reel-candidates`)).body
        .items;
      await a.post(`/sermons/${sermonId}/reel-candidates`).expect(202);
      await t.infra.queue.drain();
      const after = (await a.get(`/sermons/${sermonId}/reel-candidates`)).body
        .items;
      expect(after).toHaveLength(before.length);
      expect(after[0].id).not.toBe(before[0].id);
    });

    it('marks audio-only sermons as not renderable', async () => {
      const audioId = await a.readySermon('Audio only');
      const list = await a
        .get(`/sermons/${audioId}/reel-candidates`)
        .expect(200);
      expect(list.body.renderable).toBe(false);
      const created = await reelFromCandidate(a, audioId);
      await subscribe(churchA, 'growth', 'evt-audio');
      const refused = await a.post(`/reels/${created.id}/render`).expect(422);
      expect(refused.body.code).toBe('NO_SOURCE_VIDEO');
    });
  });

  describe('drafts, hooks and plan gates', () => {
    let reelId: string;

    it('creates a draft from a candidate with the church’s video defaults', async () => {
      await a
        .put('/brand-studio', {
          videoSettings: { captionStyle: 'POP', captionPosition: 'middle' },
        })
        .expect(200);
      await a
        .put('/brand-studio', { videoSettings: { captionStyle: 'SPARKLE' } })
        .expect(422);
      const created = await reelFromCandidate(a);
      reelId = created.id;
      expect(created).toMatchObject({
        status: 'DRAFT',
        captionStyle: 'POP',
        captionPosition: 'middle',
        hook: null,
        video: null,
      });
      const profile = await a.get('/brand-studio').expect(200);
      expect(profile.body.videoSettings).toMatchObject({
        captionStyle: 'POP',
        hookStyle: 'IMPACT',
      });
    });

    it('creates a draft from a custom window, validated against the sermon', async () => {
      await a
        .post('/reels', { sermonId, startMs: 0, endMs: 5_000 })
        .expect(422);
      await a
        .post('/reels', { sermonId, startMs: 0, endMs: 9_999_999 })
        .expect(422);
      const created = await a
        .post('/reels', { sermonId, startMs: 60_000, endMs: 90_000 })
        .expect(201);
      expect(created.body.transcript.length).toBeGreaterThan(0);
      expect(created.body.title.length).toBeGreaterThan(0);
    });

    it('needs a plan with Reels to render or write hooks', async () => {
      // Church A moved to Growth in the audio-only test; a fresh church is on Free.
      const free = new Client(t);
      await free.onboard('Free Church');
      const freeSermon = await videoSermon(free);
      const draft = await reelFromCandidate(free, freeSermon);
      const render = await free.post(`/reels/${draft.id}/render`).expect(402);
      expect(render.body.code).toBe('PLAN_UPGRADE_REQUIRED');
      expect(
        (await free.post(`/reels/${draft.id}/hooks`).expect(402)).body.code,
      ).toBe('PLAN_UPGRADE_REQUIRED');
      expect(renderJobs()).toHaveLength(0);
    });

    it('writes hook options without rendering anything', async () => {
      const response = await a.post(`/reels/${reelId}/hooks`).expect(200);
      expect(response.body.hooks).toHaveLength(3);
      for (const hook of response.body.hooks)
        expect(hook.text).not.toMatch(/^["“]/);
      const stored = await reel(a, reelId);
      expect(stored.hookOptions).toEqual(response.body.hooks);
      expect(stored.hook).toBeNull();
      expect(renderJobs()).toHaveLength(0);
      expect(t.infra.reelRenderer.renders).toHaveLength(0);
    });

    it('edits hook and captions with validation', async () => {
      await a
        .patch(`/reels/${reelId}`, {
          hook: { text: 'x'.repeat(200), style: 'IMPACT' },
        })
        .expect(422);
      await a.patch(`/reels/${reelId}`, { captionStyle: 'NOPE' }).expect(422);
      const updated = await a
        .patch(`/reels/${reelId}`, {
          hook: { text: '“Faith takes the next step”', style: 'TYPEWRITER' },
          captionStyle: 'WORD_HIGHLIGHT',
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        hook: { text: 'Faith takes the next step', style: 'TYPEWRITER' },
        captionStyle: 'WORD_HIGHLIGHT',
        editedSinceRender: false,
      });
    });
  });

  describe('rendering', () => {
    let reelId: string;

    it('queues once, renders the real moment and stores the output as media', async () => {
      const draft = await reelFromCandidate(a, sermonId, 1);
      reelId = draft.id;
      await a
        .patch(`/reels/${reelId}`, {
          hook: { text: 'Trust Him today', style: 'IMPACT' },
        })
        .expect(200);
      const queued = await a.post(`/reels/${reelId}/render`).expect(202);
      expect(queued.body).toMatchObject({
        status: 'QUEUED',
        rendering: true,
        progress: 0,
      });
      // A double click does not render (or charge) twice.
      const again = await a.post(`/reels/${reelId}/render`).expect(202);
      expect(again.body.status).toBe('QUEUED');
      expect(renderJobs()).toHaveLength(1);
      await a.patch(`/reels/${reelId}`, { title: 'x' }).expect(409);

      await t.infra.queue.drain();
      const done = await reel(a, reelId);
      expect(done).toMatchObject({
        status: 'COMPLETED',
        progress: 100,
        rendering: false,
        errorMessage: null,
        video: {
          assetId: expect.any(String),
          thumbnailAssetId: expect.any(String),
          url: expect.stringContaining('generated%2Freels'),
          thumbnailUrl: expect.stringContaining('generated%2Fthumbnails'),
        },
      });
      expect(t.infra.reelRenderer.stages).toEqual([
        'ADDING_HOOK',
        'ADDING_CAPTIONS',
        'BRANDING',
        'ENCODING',
      ]);

      const input = t.infra.reelRenderer.renders.at(-1);
      expect(input).toMatchObject({
        startMs: draft.startMs,
        endMs: draft.endMs,
        width: 1080,
        height: 1920,
        hook: { text: 'Trust Him today', style: 'IMPACT', durationMs: 3_000 },
        labels: { speaker: 'Pastor Ade', church: 'Grace Chapel' },
        logoPosition: 'top-right',
        outro: { durationMs: 2_500, churchName: 'Grace Chapel' },
      });
      // Landscape source: the speaker tracker ran and the crop follows the speaker (right third).
      expect(t.infra.speakerTracker.calls).toBe(1);
      expect(input?.crop?.cropWidth).toBe(606);
      expect(input?.crop?.keyframes[0]?.x).toBeGreaterThan(900);
      // Captions come from real word timings, relative to the clip.
      expect(input?.captions.cues.length).toBeGreaterThan(0);
      expect(input?.captions.cues[0]?.words?.length).toBeGreaterThan(0);
      expect(input?.captions.cues[0]?.startMs).toBeGreaterThanOrEqual(0);

      const media = await a.get(`/media/${done.video.assetId}`).expect(200);
      expect(media.body).toMatchObject({
        kind: 'VIDEO',
        status: 'READY',
        contentType: 'video/mp4',
      });
      const usage = t.infra.db.usageEvents.filter(
        (event) => event.churchId === churchA,
      );
      expect(
        usage.filter((event) => event.unit === 'REEL_RENDERED'),
      ).toHaveLength(1);
      expect(usage.some((event) => event.unit === 'RENDER_SECOND')).toBe(true);
      expect((await a.get('/billing/usage')).body).toMatchObject({
        reelsUsed: 1,
        reelsLimit: 8,
      });
    });

    it('approves the latest render; an edit makes it out of date until re-rendered', async () => {
      const approved = await a.post(`/reels/${reelId}/approve`).expect(200);
      expect(approved.body.approvedAt).toEqual(expect.any(String));
      await a.post(`/reels/${reelId}/approve`).expect(200);
      // Nothing changed: no new render.
      await a.post(`/reels/${reelId}/render`).expect(202);
      expect(renderJobs()).toHaveLength(1);

      const edited = await a
        .patch(`/reels/${reelId}`, { captionStyle: 'CLEAN' })
        .expect(200);
      expect(edited.body).toMatchObject({
        editedSinceRender: true,
        approvedAt: null,
        status: 'COMPLETED',
      });
      await a.post(`/reels/${reelId}/approve`).expect(409);
      await a.post(`/reels/${reelId}/render`).expect(202);
      await t.infra.queue.drain();
      const rerendered = await reel(a, reelId);
      expect(rerendered).toMatchObject({
        status: 'COMPLETED',
        editedSinceRender: false,
      });
      expect((await a.get('/billing/usage')).body.reelsUsed).toBe(2);
    });

    it('fails visibly on a permanent render error, frees the slot and can be retried', async () => {
      const draft = await reelFromCandidate(a, sermonId, 2);
      t.infra.reelRenderer.failNext = new PermanentJobError(
        'boom',
        'The video could not be encoded.',
      );
      await a.post(`/reels/${draft.id}/render`).expect(202);
      await t.infra.queue.drain();
      expect(await reel(a, draft.id)).toMatchObject({
        status: 'FAILED',
        errorMessage: 'The video could not be encoded.',
      });
      await a.post(`/reels/${draft.id}/render`).expect(202);
      await t.infra.queue.drain();
      expect((await reel(a, draft.id)).status).toBe('COMPLETED');
    });

    it('stops and cleans up when the Reel is deleted mid-render', async () => {
      const draft = await reelFromCandidate(a, sermonId, 3);
      const assetsBefore = t.infra.db.mediaAssets.size;
      const usageBefore = t.infra.db.usageEvents.filter(
        (event) => event.unit === 'REEL_RENDERED',
      ).length;
      t.infra.reelRenderer.duringRender = async () => {
        await a.delete(`/reels/${draft.id}`).expect(204);
      };
      await a.post(`/reels/${draft.id}/render`).expect(202);
      await t.infra.queue.drain();
      t.infra.reelRenderer.duringRender = null;
      await a.get(`/reels/${draft.id}`).expect(404);
      expect(t.infra.db.mediaAssets.size).toBe(assetsBefore);
      expect(
        t.infra.db.usageEvents.filter(
          (event) => event.unit === 'REEL_RENDERED',
        ),
      ).toHaveLength(usageBefore);
      // Deleting again is a no-op.
      await a.delete(`/reels/${draft.id}`).expect(204);
    });

    it('fails renders whose worker died, so the UI stops waiting', async () => {
      const draft = await reelFromCandidate(a, sermonId, 4);
      await a.post(`/reels/${draft.id}/render`).expect(202);
      t.infra.queue.jobs.length = 0; // the worker and its job are gone
      const recover = t.app.get(RecoverStuckReelsUseCase);
      expect(await recover.execute()).toBe(0);
      t.infra.clock.advance(61 * 60 * 1000);
      expect(await recover.execute()).toBe(1);
      expect(await reel(a, draft.id)).toMatchObject({
        status: 'FAILED',
        rendering: false,
      });
    });

    it('enforces the plan’s Reel allowance, counting renders in flight', async () => {
      const used = (await a.get('/billing/usage')).body.reelsUsed as number;
      const ids: string[] = [];
      for (let i = 0; i < 8 - used; i++) {
        const created = await a
          .post('/reels', {
            sermonId,
            startMs: 20_000 + i * 1_000,
            endMs: 50_000 + i * 1_000,
          })
          .expect(201);
        ids.push(created.body.id);
        await a.post(`/reels/${created.body.id}/render`).expect(202);
      }
      // All of them are still queued: in-flight renders already use the allowance.
      const extra = await a
        .post('/reels', { sermonId, startMs: 100_000, endMs: 130_000 })
        .expect(201);
      const refused = await a
        .post(`/reels/${extra.body.id}/render`)
        .expect(402);
      expect(refused.body.code).toBe('REEL_LIMIT_REACHED');
      await t.infra.queue.drain();
      expect((await a.get('/billing/usage')).body.reelsUsed).toBe(8);
      await a.post(`/reels/${extra.body.id}/render`).expect(402);
    });

    it('lists Reels, newest first, filtered and paginated', async () => {
      const page = await a
        .get(`/reels?sermonId=${sermonId}&status=COMPLETED&pageSize=2`)
        .expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.total).toBeGreaterThan(2);
      expect(
        page.body.data.every(
          (item: { status: string }) => item.status === 'COMPLETED',
        ),
      ).toBe(true);
      // List items carry asset ids but no signed URLs.
      expect(page.body.data[0].video).not.toHaveProperty('url');
      await a.get('/reels?pageSize=500').expect(422);
      await a.get('/reels?status=DANCING').expect(422);
    });

    it('publishes a rendered Reel through the social adapters with independent results', async () => {
      const done = (
        await a.get(`/reels?sermonId=${sermonId}&status=COMPLETED&pageSize=1`)
      ).body.data[0];
      const connections: Record<string, string> = {};
      for (const provider of ['tiktok', 'youtube']) {
        const start = await a
          .get(`/social/connections/${provider}/authorize`)
          .expect(200);
        const state =
          new URL(start.body.authorizationUrl).searchParams.get('state') ?? '';
        await a
          .get(
            `/social/oauth/${provider}/callback?code=good-code&state=${state}`,
          )
          .expect(302);
      }
      for (const connection of (await a.get('/social/connections')).body)
        connections[connection.platform] = connection.id;
      const post = await a.post('/social/posts', {
        caption: 'Faith takes the next step.',
        mediaAssetIds: [done.video.assetId],
        thumbnailAssetId: done.video.thumbnailAssetId,
        targets: [
          {
            platform: 'tiktok',
            connectionId: connections.tiktok,
            settings: { privacyLevel: 'PUBLIC_TO_EVERYONE' },
          },
          {
            platform: 'youtube',
            connectionId: connections.youtube,
            settings: { privacyStatus: 'public', madeForKids: false },
          },
        ],
      });
      expect(post.body.errors ?? {}).toEqual({});
      expect(post.status).toBe(201);
      t.infra.social.youtube.publishSteps = [new Error('YouTube is down')];
      await a
        .post(`/social/posts/${post.body.id}/publish`, {}, key())
        .expect(202);
      await t.infra.queue.drain();
      const result = (await a.get(`/social/posts/${post.body.id}`).expect(200))
        .body;
      const byPlatform = Object.fromEntries(
        result.publications.map((p: { platform: string; status: string }) => [
          p.platform,
          p.status,
        ]),
      );
      expect(byPlatform.tiktok).toBe('published');
      expect(byPlatform.youtube).not.toBe('published');
      expect(result.status).toBe('partially_published');
      const published = t.infra.social.tiktok.published.at(-1);
      expect(JSON.stringify(published)).toContain('video');
      expect(
        t.infra.db.usageEvents.filter(
          (event) =>
            event.churchId === churchA && event.unit === 'SOCIAL_PUBLICATION',
        ),
      ).toHaveLength(1);
    });
  });

  describe('source retention', () => {
    it('removes the original after the plan’s retention but keeps everything derived from it', async () => {
      const free = new Client(t);
      await free.onboard('Retention Church');
      const id = await videoSermon(free, 'Short retention');
      const asset = [...t.infra.db.assets.values()].find(
        (row) => row.sermonId === id,
      );
      expect(asset?.expiresAt?.getTime()).toBe(
        t.infra.clock.now().getTime() + 3 * 86_400_000,
      );
      const purge = t.app.get(PurgeExpiredSourcesUseCase);
      expect(await purge.execute()).toBe(0);
      t.infra.clock.advance(3 * 86_400_000 + 1);
      expect(await purge.execute()).toBeGreaterThanOrEqual(1);
      expect(await purge.execute()).toBe(0); // idempotent
      expect(
        await t.infra.storage.headObject(asset?.objectKey ?? ''),
      ).toBeNull();
      await free.login();
      await free.get(`/sermons/${id}/transcript`).expect(200);
      const candidates = await free
        .get(`/sermons/${id}/reel-candidates`)
        .expect(200);
      expect(candidates.body.renderable).toBe(false);
      expect(candidates.body.items.length).toBeGreaterThan(0);
      const draft = await free
        .post('/reels', { candidateId: candidates.body.items[0].id })
        .expect(201);
      const refused = await free
        .post(`/reels/${draft.body.id}/render`)
        .expect(422);
      expect(refused.body.code).toBe('SOURCE_EXPIRED');
    });

    it('keeps the original while the sermon is still processing', async () => {
      const free = new Client(t);
      await free.onboard('Slow Church');
      const id = await free.createSermon('Still processing'); // not drained
      t.infra.clock.advance(3 * 86_400_000 + 1);
      await t.app.get(PurgeExpiredSourcesUseCase).execute();
      const asset = [...t.infra.db.assets.values()].find(
        (row) => row.sermonId === id,
      );
      expect(asset?.deletedAt).toBeNull();
      t.infra.queue.jobs.length = 0;
    });
  });

  describe('tenant isolation', () => {
    it('never shows or touches another church’s Reels or candidates', async () => {
      await a.login();
      await b.login(); // the clock moved past both sessions in the retention tests
      const mine = await reelFromCandidate(a);
      const candidates = (await a.get(`/sermons/${sermonId}/reel-candidates`))
        .body.items;
      await b.get(`/sermons/${sermonId}/reel-candidates`).expect(404);
      await b.post(`/sermons/${sermonId}/reel-candidates`).expect(404);
      await b.post('/reels', { candidateId: candidates[0].id }).expect(404);
      await b
        .post('/reels', { sermonId, startMs: 0, endMs: 30_000 })
        .expect(404);
      await b.get(`/reels/${mine.id}`).expect(404);
      await b.patch(`/reels/${mine.id}`, { title: 'hijack' }).expect(404);
      await b.post(`/reels/${mine.id}/render`).expect(404);
      await b.post(`/reels/${mine.id}/hooks`).expect(404);
      await b.post(`/reels/${mine.id}/approve`).expect(404);
      await b.delete(`/reels/${mine.id}`).expect(204);
      expect((await b.get('/reels')).body.data).toEqual([]);
      expect((await reel(a, mine.id)).title).not.toBe('hijack');
    });
  });
});
