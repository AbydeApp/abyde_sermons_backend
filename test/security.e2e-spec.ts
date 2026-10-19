import request from 'supertest';
import { HealthService } from '../src/modules/health/health.service.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('HTTP security and conventions (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ APP_RATE_LIMIT_MAX: '10000' });
  });
  afterAll(() => t.close());

  it('rejects state-changing requests from foreign origins (CSRF)', async () => {
    const response = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@b.co', password: 'x' })
      .expect(403);
    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      errors: {},
    });
    await request(t.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('serves CORS only to the allowlist, with credentials', async () => {
    const allowed = await request(t.app.getHttpServer())
      .options('/api/v1/auth/me')
      .set('Origin', 'http://web.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://web.test',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(t.app.getHttpServer())
      .options('/api/v1/auth/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and request ids', async () => {
    const response = await request(t.app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('uses one error envelope and never leaks internals', async () => {
    const notFound = await request(t.app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(notFound.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: expect.any(String),
      errors: {},
      requestId: expect.any(String),
    });
    const malformed = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(malformed.body.code).toBe('BAD_REQUEST');
    const client = new Client(t);
    await client.onboard('Envelope Church');
    const badId = await client.get('/sermons/not-a-uuid').expect(404);
    expect(badId.body.code).toBe('NOT_FOUND');
    const invalid = await client.get('/sermons?pageSize=500').expect(422);
    expect(invalid.body.errors.pageSize[0]).toMatch(/at most 100/);
  });

  it('treats SQL-ish input as plain data', async () => {
    const client = new Client(t);
    await client.onboard('Injection Church');
    const response = await client
      .get(`/sermons?q=${encodeURIComponent("'; DROP TABLE sermons; --")}`)
      .expect(200);
    expect(response.body.data).toEqual([]);
  });

  it('replays idempotent writes and rejects key reuse with a different body', async () => {
    const client = new Client(t);
    await client.onboard('Idem Church');
    const body = {
      title: 'Idempotent',
      speaker: 'X',
      sermonDate: '2026-09-27T09:00:00Z',
      transcriptText: 'Grace upon grace. '.repeat(30),
    };
    const first = await client
      .post('/sermons', body, { 'Idempotency-Key': 'sermon-create-0001' })
      .expect(202);
    const second = await client
      .post('/sermons', body, { 'Idempotency-Key': 'sermon-create-0001' })
      .expect(202);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(
      [...t.infra.db.sermons.values()].filter(
        (sermon) => sermon.title === 'Idempotent',
      ),
    ).toHaveLength(1);
    const reused = await client
      .post(
        '/sermons',
        { ...body, title: 'Other' },
        { 'Idempotency-Key': 'sermon-create-0001' },
      )
      .expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires an Idempotency-Key on endpoints that must never run twice', async () => {
    const client = new Client(t);
    await client.onboard('Required Key Church');
    for (const path of ['/billing/checkout', '/billing/portal']) {
      const missing = await client.post(path, {}).expect(422);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    const forgot = await new Client(t)
      .post('/auth/forgot-password', { email: 'someone@example.com' })
      .expect(422);
    expect(forgot.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const first = await client
      .post(
        '/billing/checkout',
        { planId: 'starter' },
        { 'Idempotency-Key': 'checkout-key-0001' },
      )
      .expect(200);
    const replay = await client
      .post(
        '/billing/checkout',
        { planId: 'starter' },
        { 'Idempotency-Key': 'checkout-key-0001' },
      )
      .expect(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('stores client errors for a key, answers 409 with Retry-After while in flight, and scopes keys per user', async () => {
    const client = new Client(t);
    await client.onboard('Contract Church');
    const invalid = { title: '', speaker: 'X', sermonDate: 'nope' };
    const first = await client
      .post('/sermons', invalid, { 'Idempotency-Key': 'invalid-sermon-0001' })
      .expect(422);
    const replay = await client
      .post('/sermons', invalid, { 'Idempotency-Key': 'invalid-sermon-0001' })
      .expect(422);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.errors).toEqual(first.body.errors);

    // Simulate the first request still running: its in-flight lock exists.
    const userId = (await client.get('/auth/me')).body.user.id;
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256')
      .update(`${userId}|POST|/api/v1/sermons|in-flight-key-0001`)
      .digest('hex');
    await t.infra.cache.setIfAbsent(`idempotency:lock:${key}`, 1, 120);
    const busy = await client
      .post('/sermons', invalid, { 'Idempotency-Key': 'in-flight-key-0001' })
      .expect(409);
    expect(busy.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(busy.headers['retry-after']).toBe('2');

    // Another user reusing the same key string gets their own result, never this user's.
    const other = new Client(t);
    await other.onboard('Other Contract Church');
    const body = {
      title: 'Mine',
      speaker: 'X',
      sermonDate: '2026-09-27T09:00:00Z',
      transcriptText: 'Grace upon grace. '.repeat(30),
    };
    const mine = await client
      .post('/sermons', body, { 'Idempotency-Key': 'shared-key-string-01' })
      .expect(202);
    const theirs = await other
      .post('/sermons', body, { 'Idempotency-Key': 'shared-key-string-01' })
      .expect(202);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(theirs.body.id).not.toBe(mine.body.id);
  });

  it('keeps the default 100 KB body limit, with a larger limit only for sermon creation', async () => {
    const client = new Client(t);
    await client.onboard('Body Limit Church');
    const tooBig = await client
      .patch('/church', { description: 'x'.repeat(150_000) })
      .expect(413);
    expect(tooBig.body.code).toBe('PAYLOAD_TOO_LARGE');
    await client
      .post('/sermons', {
        title: 'Long transcript',
        speaker: 'X',
        sermonDate: '2026-09-27T09:00:00Z',
        transcriptText: 'Faith and hope and love. '.repeat(20_000),
      })
      .expect(202);
  });

  it('reports not-ready as soon as shutdown starts, while liveness stays up', async () => {
    const draining = await createTestApp();
    try {
      await request(draining.app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      await draining.app.get(HealthService).beforeApplicationShutdown();
      const ready = await request(draining.app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(ready.body.code).toBe('NOT_READY');
      await request(draining.app.getHttpServer()).get('/health').expect(200);
    } finally {
      await draining.close();
    }
  });

  it('reports liveness and readiness outside the API prefix', async () => {
    await request(t.app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok' });
    await request(t.app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('rate limits clients beyond the configured budget', async () => {
    const limited = await createTestApp({ APP_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (await request(limited.app.getHttpServer()).get('/api/v1/auth/me'))
            .status,
        );
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('protects /metrics with a bearer token when configured', async () => {
    const withToken = await createTestApp({
      OBSERVABILITY_METRICS_TOKEN: 'scrape-secret-123',
    });
    try {
      await request(withToken.app.getHttpServer()).get('/metrics').expect(404);
      const ok = await request(withToken.app.getHttpServer())
        .get('/metrics')
        .set('Authorization', 'Bearer scrape-secret-123')
        .expect(200);
      expect(ok.text).toContain('http_request_duration_seconds');
    } finally {
      await withToken.close();
      delete process.env.OBSERVABILITY_METRICS_TOKEN;
    }
  });
});
