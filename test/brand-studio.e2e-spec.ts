import { Client, createTestApp, type TestApp } from './support/test-app.js';

/** Brand Studio: profile, logo assets and the queued media pipeline. */
describe('brand studio and media pipeline (e2e)', () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  let churchA: string;
  let quoteId: string;

  const videoSermon = async (client: Client): Promise<string> => {
    const bytes = Buffer.from('fake-mp4-bytes');
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'sermon.mp4',
        contentType: 'video/mp4',
        sizeBytes: bytes.length,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    t.infra.storage.put(presign.body.objectKey, bytes, 'video/mp4');
    const created = await client
      .post('/sermons', {
        title: 'Faith Over Fear',
        speaker: 'Pastor Ade',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey: presign.body.objectKey,
      })
      .expect(202);
    await t.infra.queue.drain();
    return created.body.id as string;
  };

  const generate = async (
    client: Client,
    sermonId: string,
    types: string[],
  ) => {
    await client
      .post(`/sermons/${sermonId}/generate-week`, { contentTypes: types })
      .expect(202);
    await t.infra.queue.drain();
    return (await client.get(`/content?sermonId=${sermonId}`).expect(200)).body
      .data as Array<{
      id: string;
      type: string;
    }>;
  };

  beforeAll(async () => {
    t = await createTestApp();
    a = new Client(t);
    b = new Client(t);
    churchA = await a.onboard('Grace Chapel');
    await b.onboard('Other Church');
    const sermonId = await videoSermon(a);
    const content = await generate(a, sermonId, ['QUOTE', 'SOCIAL_POST']);
    quoteId = content.find((item) => item.type === 'QUOTE')?.id ?? '';
  });
  afterAll(() => t.close());

  it('starts from a default profile seeded from the church', async () => {
    const profile = await a.get('/brand-studio').expect(200);
    expect(profile.body).toMatchObject({
      churchName: 'Grace Chapel',
      primaryColor: '#1F2A44',
      headingFont: 'Inter',
      watermarkEnabled: false,
      churchId: churchA,
      logoAssetId: null,
      alternateLogoAssetId: null,
      watermarkPosition: 'bottom-right',
      footerText: null,
      assets: [],
      voice: { emojiUsage: 'rarely', preferredTerms: [], avoidPhrases: [] },
    });
  });

  it('validates and saves brand and voice', async () => {
    await a.put('/brand-studio', { primaryColor: 'blue' }).expect(422);
    // Read-only keys the client echoes back are ignored, not stored.
    await a
      .put('/brand-studio', { primaryColor: '#000000', assets: [], logoUrl: 'x' })
      .expect(200);
    const saved = await a
      .put('/brand-studio', {
        primaryColor: '#0a3d62',
        accentColor: '#f6b93b',
        socialHandle: 'gracechapel',
        footerText: 'Join us Sundays at 9',
        voice: {
          tone: 'Warm and hopeful',
          preferredTerms: [
            { preferred: 'church family', insteadOf: 'members' },
          ],
          hashtagPreferences: ['GraceChapel'],
        },
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      primaryColor: '#0A3D62',
      socialHandle: '@gracechapel',
      footerText: 'Join us Sundays at 9',
      voice: { tone: 'Warm and hopeful', hashtagPreferences: ['#GraceChapel'] },
    });
    expect((await a.get('/brand-studio')).body.primaryColor).toBe('#0A3D62');
  });

  it('uploads a logo through a presigned URL and only attaches it once it exists', async () => {
    await a
      .post('/brand-studio/assets/presign', {
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 10,
      })
      .expect(422);
    await a
      .post('/brand-studio/assets/presign', {
        fileName: 'portrait.png',
        contentType: 'image/png',
        sizeBytes: 10,
        kind: 'PORTRAIT',
      })
      .expect(422);
    const presign = await a
      .post('/brand-studio/assets/presign', {
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: 4,
        kind: 'LOGO',
      })
      .expect(200);
    expect(presign.body.objectKey).toBe(
      `churches/${churchA}/brand/${presign.body.assetId}.png`,
    );
    const attach = {
      logoAssetId: presign.body.assetId,
      watermarkEnabled: true,
    };
    // Not uploaded yet.
    await a.put('/brand-studio', attach).expect(422);
    // Another church cannot attach (or even see) this asset.
    await b.put('/brand-studio', attach).expect(422);
    t.infra.storage.put(
      presign.body.objectKey,
      Buffer.from('png!'),
      'image/png',
    );
    const saved = await a.put('/brand-studio', attach).expect(200);
    expect(saved.body.logoAssetId).toBe(presign.body.assetId);
    expect(saved.body.assets).toEqual([
      {
        id: presign.body.assetId,
        kind: 'LOGO',
        name: 'logo.png',
        url: expect.stringContaining('memory://download'),
        createdAt: expect.any(String),
      },
    ]);
    expect((await b.get('/brand-studio')).body).toMatchObject({
      logoAssetId: null,
      assets: [],
    });
  });

  it('queues image and carousel renders and stores them under the sermon', async () => {
    const accepted = await a
      .post(`/content/${quoteId}/render`, { format: 'image' })
      .expect(202);
    // The response is the content item, whose `visual` the client polls.
    expect(accepted.body).toMatchObject({
      id: quoteId,
      visual: { status: 'RENDERING', assets: [], thumbnailUrl: null },
    });
    expect(t.infra.renderer.images).toHaveLength(0); // nothing rendered in the request
    await t.infra.queue.drain();
    const rendered = await a.get(`/content/${quoteId}`).expect(200);
    expect(rendered.body.visual).toMatchObject({
      status: 'READY',
      assets: [{ kind: 'image', width: 1080, url: expect.any(String) }],
    });
    const image = await a
      .get(`/media/${rendered.body.visual.assets[0].id}`)
      .expect(200);
    expect(image.body).toMatchObject({
      status: 'READY',
      contentType: 'image/jpeg',
      width: 1080,
    });
    const card = t.infra.renderer.images[0];
    expect(card?.card.template.id).toEqual(expect.any(String));
    expect(card?.card.brand).toMatchObject({
      primaryColor: '#0A3D62',
      logoObjectKey: expect.stringContaining('/brand/'),
    });
    expect(card?.logoPath).toBeDefined();
    const stored = [...t.infra.storage.objects.keys()].filter((key) =>
      key.includes('/generated/images/'),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(
      new RegExp(`^churches/${churchA}/sermons/[^/]+/generated/images/`),
    );

    t.infra.clock.advance(1000); // renders are told apart by their creation time
    const carousel = await a
      .post(`/content/${quoteId}/render`, {
        format: 'carousel',
        templateId: 'minimal-light',
        aspect: 'portrait',
      })
      .expect(202);
    expect(carousel.body.visual.status).toBe('RENDERING');
    await t.infra.queue.drain();
    const slides = (await a.get(`/content/${quoteId}`)).body.visual;
    expect(slides.status).toBe('READY');
    expect(slides.assets.length).toBeGreaterThanOrEqual(2);
    const media = await a.get(`/content/${quoteId}/media`).expect(200);
    expect(
      media.body.every((asset: { status: string }) => asset.status === 'READY'),
    ).toBe(true);
  });

  it('accepts the web app\'s format names and text overrides', async () => {
    t.infra.clock.advance(1000);
    await a
      .post(`/content/${quoteId}/render`, {
        format: 'story',
        overrides: { headline: 'Sunday', body: 'Come as you are' },
      })
      .expect(202);
    await t.infra.queue.drain();
    const card = t.infra.renderer.images.at(-1)?.card;
    expect(card).toMatchObject({
      width: 1080,
      height: 1920,
      heading: 'Sunday',
      text: 'Come as you are',
    });
    await a
      .post(`/content/${quoteId}/render`, { format: 'tiktok' })
      .expect(422);
  });

  it('cuts a captioned vertical clip and a thumbnail from a video sermon in the worker', async () => {
    t.infra.clock.advance(1000);
    const accepted = await a
      .post(`/content/${quoteId}/render`, {
        format: 'video',
        clip: { startMs: 10_000, endMs: 40_000 },
      })
      .expect(202);
    expect(accepted.body.visual.status).toBe('RENDERING');
    await t.infra.queue.drain();
    const done = (await a.get(`/content/${quoteId}`)).body.visual;
    expect(done).toMatchObject({
      status: 'READY',
      assets: [{ kind: 'video', width: 1080, height: 1920 }],
      thumbnailUrl: expect.any(String),
    });
    const video = t.infra.renderer.videos.at(-1);
    expect(video).toMatchObject({
      startMs: 10_000,
      endMs: 40_000,
      width: 1080,
      height: 1920,
    });
    expect(video?.captions.length).toBeGreaterThan(0);
    const clip = await a.get(`/media/${done.assets[0].id}`).expect(200);
    expect(clip.body).toMatchObject({
      status: 'READY',
      contentType: 'video/mp4',
      durationMs: 30_000,
    });
    await a
      .post(`/content/${quoteId}/render`, {
        format: 'image',
        clip: { startMs: 0, endMs: 9000 },
      })
      .expect(422);
    await a
      .post(`/content/${quoteId}/render`, {
        format: 'video',
        clip: { startMs: 0, endMs: 1000 },
      })
      .expect(422);
  });

  it('marks a failed render as failed instead of leaving it pending', async () => {
    t.infra.renderer.failVideos = true;
    t.infra.clock.advance(1000);
    await a
      .post(`/content/${quoteId}/render`, {
        format: 'video',
        clip: { startMs: 0, endMs: 20_000 },
      })
      .expect(202);
    await t.infra.queue.drain();
    t.infra.renderer.failVideos = false;
    expect((await a.get(`/content/${quoteId}`)).body.visual).toMatchObject({
      status: 'FAILED',
      errorMessage: expect.any(String),
    });
  });

  it('refuses clips from sermons without video and keeps media private to the church', async () => {
    const audioSermon = await a.readySermon('Audio Only');
    const [item] = await generate(a, audioSermon, ['PRAYER']);
    const refused = await a
      .post(`/content/${item?.id}/render`, { format: 'video' })
      .expect(422);
    expect(refused.body.code).toBe('NO_SOURCE_VIDEO');

    const media = (await a.get(`/content/${quoteId}/media`)).body as Array<{
      id: string;
    }>;
    await b.get(`/media/${media[0]?.id}`).expect(404);
    await b.get(`/content/${quoteId}/media`).expect(404);
    await b.post(`/content/${quoteId}/render`, { format: 'image' }).expect(404);
  });

  it('deletes logo assets idempotently and detaches them from the profile', async () => {
    const assetId = (await a.get('/brand-studio')).body.logoAssetId as string;
    await b.delete(`/brand-studio/assets/${assetId}`).expect(204); // a no-op for another church
    expect((await a.get('/brand-studio')).body.logoAssetId).not.toBeNull();
    await a.delete(`/brand-studio/assets/${assetId}`).expect(204);
    await a.delete(`/brand-studio/assets/${assetId}`).expect(204);
    expect((await a.get('/brand-studio')).body).toMatchObject({
      logoAssetId: null,
      assets: [],
    });
    expect(
      [...t.infra.storage.objects.keys()].some((key) => key.includes(assetId)),
    ).toBe(false);
  });
});
