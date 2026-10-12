import { Client, createTestApp, type TestApp } from './support/test-app.js';

/** Brand Studio: profile, logo assets, templates, preview and the queued media pipeline. */
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
      logo: null,
      voice: { emojiUsage: 'rarely', preferredTerms: [], avoidPhrases: [] },
    });
    expect(profile.body).not.toHaveProperty('churchId');
  });

  it('validates and saves brand and voice', async () => {
    // Unknown keys are rejected, not silently stored.
    const invalid = await a
      .put('/brand-studio', { primaryColor: '#000000', extra: true })
      .expect(422);
    expect(JSON.stringify(invalid.body.errors)).toContain('extra');
    await a.put('/brand-studio', { primaryColor: 'blue' }).expect(422);
    const saved = await a
      .put('/brand-studio', {
        primaryColor: '#0a3d62',
        accentColor: '#f6b93b',
        socialHandle: 'gracechapel',
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
    const presign = await a
      .post('/brand-studio/assets/presign', {
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: 4,
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
    expect(saved.body.logo).toEqual({
      assetId: presign.body.assetId,
      url: expect.stringContaining('memory://download'),
    });
    expect((await b.get('/brand-studio')).body.logo).toBeNull();
  });

  it('lists templates, sets defaults per content type, and previews without rendering', async () => {
    const catalog = await a.get('/brand-studio/templates').expect(200);
    expect(
      catalog.body.templates.map((tpl: { id: string }) => tpl.id),
    ).toContain('gradient-quote');
    await a
      .put('/brand-studio/templates/quote/default', { templateId: 'nope' })
      .expect(422);
    await a
      .put('/brand-studio/templates/sermon/default', {
        templateId: 'gradient-quote',
      })
      .expect(404);
    await a
      .put('/brand-studio/templates/quote/default', {
        templateId: 'gradient-quote',
      })
      .expect(200);
    expect((await a.get('/brand-studio/templates')).body.defaults).toEqual({
      QUOTE: 'gradient-quote',
    });

    const preview = await a
      .post('/brand-studio/preview', {
        text: 'Faith <over> fear',
        aspect: 'portrait',
        brand: { accentColor: '#FF0000' },
      })
      .expect(200);
    expect(preview.body).toMatchObject({ width: 1080, height: 1350 });
    expect(preview.body.svg).toContain('Faith &lt;over&gt; fear');
    expect(preview.body.svg).toContain('#FF0000');
    expect(preview.body.logo).toMatchObject({
      url: expect.any(String),
      width: expect.any(Number),
    });
    // Previewing does not save anything.
    expect((await a.get('/brand-studio')).body.accentColor).toBe('#F6B93B');
  });

  it('queues image and carousel renders and stores them under the sermon', async () => {
    const accepted = await a
      .post(`/content/${quoteId}/render`, { format: 'image' })
      .expect(202);
    expect(accepted.body).toMatchObject({
      status: 'rendering',
      assets: [{ kind: 'IMAGE', status: 'PENDING', url: null }],
    });
    expect(t.infra.renderer.images).toHaveLength(0); // nothing rendered in the request
    await t.infra.queue.drain();
    const image = await a
      .get(`/media/${accepted.body.assets[0].id}`)
      .expect(200);
    expect(image.body).toMatchObject({
      status: 'READY',
      contentType: 'image/jpeg',
      width: 1080,
      url: expect.any(String),
    });
    const card = t.infra.renderer.images[0];
    expect(card?.card.template.id).toBe('gradient-quote'); // the church default for quotes
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

    const carousel = await a
      .post(`/content/${quoteId}/render`, {
        format: 'carousel',
        templateId: 'minimal-light',
        aspect: 'portrait',
      })
      .expect(202);
    expect(carousel.body.assets.length).toBeGreaterThanOrEqual(2);
    await t.infra.queue.drain();
    const media = await a.get(`/content/${quoteId}/media`).expect(200);
    expect(
      media.body.every((asset: { status: string }) => asset.status === 'READY'),
    ).toBe(true);
  });

  it('cuts a captioned vertical clip and a thumbnail from a video sermon in the worker', async () => {
    const accepted = await a
      .post(`/content/${quoteId}/render`, {
        format: 'video',
        clip: { startMs: 10_000, endMs: 40_000 },
      })
      .expect(202);
    expect(
      accepted.body.assets.map((asset: { kind: string }) => asset.kind),
    ).toEqual(['VIDEO', 'THUMBNAIL']);
    await t.infra.queue.drain();
    const video = t.infra.renderer.videos.at(-1);
    expect(video).toMatchObject({
      startMs: 10_000,
      endMs: 40_000,
      width: 1080,
      height: 1920,
    });
    expect(video?.captions.length).toBeGreaterThan(0);
    const clip = await a
      .get(`/media/${accepted.body.assets[0].id}`)
      .expect(200);
    expect(clip.body).toMatchObject({
      status: 'READY',
      contentType: 'video/mp4',
      durationMs: 30_000,
    });
    expect(
      (await a.get(`/media/${accepted.body.assets[1].id}`)).body.status,
    ).toBe('READY');
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
    const accepted = await a.post(`/content/${quoteId}/render`, {
      format: 'video',
      clip: { startMs: 0, endMs: 20_000 },
    });
    await t.infra.queue.drain();
    t.infra.renderer.failVideos = false;
    const clip = await a
      .get(`/media/${accepted.body.assets[0].id}`)
      .expect(200);
    expect(clip.body).toMatchObject({
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
    const assetId = (await a.get('/brand-studio')).body.logo.assetId as string;
    await b.delete(`/brand-studio/assets/${assetId}`).expect(204); // a no-op for another church
    expect((await a.get('/brand-studio')).body.logo).not.toBeNull();
    await a.delete(`/brand-studio/assets/${assetId}`).expect(204);
    await a.delete(`/brand-studio/assets/${assetId}`).expect(204);
    expect((await a.get('/brand-studio')).body.logo).toBeNull();
    expect(
      [...t.infra.storage.objects.keys()].some((key) => key.includes(assetId)),
    ).toBe(false);
  });
});
