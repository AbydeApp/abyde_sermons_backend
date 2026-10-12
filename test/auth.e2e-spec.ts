import request from 'supertest';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('authentication (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('returns a signed-out Me with 200', async () => {
    const response = await new Client(t).get('/auth/me').expect(200);
    expect(response.body).toEqual({
      authenticated: false,
      user: null,
      onboardingCompleted: false,
      church: null,
    });
  });

  it('normalises emails and rejects duplicates with EMAIL_TAKEN', async () => {
    await new Client(t)
      .post('/auth/register', {
        fullName: 'One',
        email: '  Dup@Example.com ',
        password: 'Faith2026!',
      })
      .expect(201);
    const duplicate = await new Client(t)
      .post('/auth/register', {
        fullName: 'Two',
        email: 'dup@example.COM',
        password: 'Faith2026!',
      })
      .expect(409);
    expect(duplicate.body).toMatchObject({
      code: 'EMAIL_TAKEN',
      errors: { email: [expect.any(String)] },
    });
  });

  it('enforces the password policy with field errors', async () => {
    const weak = await new Client(t)
      .post('/auth/register', {
        fullName: 'Weak',
        email: 'weak@example.com',
        password: 'short',
      })
      .expect(422);
    expect(weak.body.errors.password[0]).toMatch(/at least 8/);
  });

  it('logs in, gives generic errors and never returns the password hash', async () => {
    await new Client(t)
      .post('/auth/register', {
        fullName: 'Login',
        email: 'login@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    const wrongPassword = await new Client(t)
      .post('/auth/login', {
        email: 'login@example.com',
        password: 'Nope2026!',
      })
      .expect(401);
    const unknownEmail = await new Client(t)
      .post('/auth/login', {
        email: 'ghost@example.com',
        password: 'Nope2026!',
      })
      .expect(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);

    const client = new Client(t);
    const ok = await client
      .post('/auth/login', {
        email: 'LOGIN@example.com',
        password: 'Faith2026!',
        remember: true,
      })
      .expect(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/hash/i);
    const expires = new Date(
      /Expires=([^;]+)/.exec(ok.headers['set-cookie']?.[0] ?? '')?.[1] ?? 0,
    );
    expect(expires.getTime() - t.infra.clock.now().getTime()).toBeGreaterThan(
      29 * 24 * 3600 * 1000,
    );
    expect((await client.get('/auth/me')).body.authenticated).toBe(true);
  });

  it('locks out repeated failures for one email', async () => {
    await new Client(t)
      .post('/auth/register', {
        fullName: 'Lock',
        email: 'lock@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    for (let i = 0; i < 10; i++)
      await new Client(t).post('/auth/login', {
        email: 'lock@example.com',
        password: 'Wrong2026!',
      });
    const locked = await new Client(t)
      .post('/auth/login', {
        email: 'lock@example.com',
        password: 'Faith2026!',
      })
      .expect(429);
    expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('limits how many "email taken" answers one client can collect', async () => {
    const probes = await createTestApp();
    try {
      await new Client(probes)
        .post('/auth/register', {
          fullName: 'Owner',
          email: 'owner@example.com',
          password: 'Faith2026!',
        })
        .expect(201);
      for (let i = 0; i < 5; i++) {
        await new Client(probes)
          .post('/auth/register', {
            fullName: 'X',
            email: 'owner@example.com',
            password: 'Faith2026!',
          })
          .expect(409);
      }
      const blocked = await new Client(probes)
        .post('/auth/register', {
          fullName: 'X',
          email: 'owner@example.com',
          password: 'Faith2026!',
        })
        .expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
    } finally {
      await probes.close();
    }
  });

  it('a lockout caused from one address does not lock the owner out from another', async () => {
    await new Client(t)
      .post('/auth/register', {
        fullName: 'Victim',
        email: 'victim@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    const attacker = { 'X-Forwarded-For': '203.0.113.9' };
    for (let i = 0; i < 10; i++)
      await new Client(t).post(
        '/auth/login',
        { email: 'victim@example.com', password: 'Wrong2026!' },
        attacker,
      );
    await new Client(t)
      .post(
        '/auth/login',
        { email: 'victim@example.com', password: 'Faith2026!' },
        attacker,
      )
      .expect(429);
    await new Client(t)
      .post(
        '/auth/login',
        { email: 'victim@example.com', password: 'Faith2026!' },
        { 'X-Forwarded-For': '198.51.100.7' },
      )
      .expect(200);
  });

  it('logs out by revoking the session (idempotently)', async () => {
    const client = new Client(t);
    await client
      .post('/auth/register', {
        fullName: 'Out',
        email: 'out@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    const cookie = (client as unknown as { cookie: string }).cookie;
    await client.post('/auth/logout').expect(204);
    await client.post('/auth/logout').expect(204);
    // The old cookie value no longer authenticates even if replayed.
    const replay = await request(t.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(replay.body.authenticated).toBe(false);
  });

  it('expires sessions after their lifetime', async () => {
    const client = new Client(t);
    await client
      .post('/auth/register', {
        fullName: 'Exp',
        email: 'exp@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    t.infra.clock.advance(25 * 3600 * 1000);
    await t.infra.cache.del(
      ...[...t.infra.db.sessions.values()].map((s) => `session:${s.tokenHash}`),
    );
    expect((await client.get('/auth/me')).body.authenticated).toBe(false);
    await client.get('/sermons').expect(401);
  });

  it('updates the profile and changes password (other sessions are signed out)', async () => {
    const device1 = new Client(t);
    const device2 = new Client(t);
    await device1
      .post('/auth/register', {
        fullName: 'Change',
        email: 'change@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    await device2
      .post('/auth/login', {
        email: 'change@example.com',
        password: 'Faith2026!',
      })
      .expect(200);

    // A name-only change needs no password; changing the sign-in email does.
    await device1.patch('/auth/me', { fullName: 'Changed Name' }).expect(200);
    const noPassword = await device1
      .patch('/auth/me', { email: 'changed@example.com' })
      .expect(422);
    expect(noPassword.body).toMatchObject({
      code: 'WRONG_PASSWORD',
      errors: { currentPassword: [expect.any(String)] },
    });
    await device1
      .patch('/auth/me', {
        email: 'changed@example.com',
        currentPassword: 'Nope2026!',
      })
      .expect(422);
    expect((await device2.get('/auth/me')).body).toMatchObject({
      authenticated: true,
      user: { email: 'change@example.com' },
    });
    const updated = await device1
      .patch('/auth/me', {
        fullName: 'Changed Name',
        email: 'changed@example.com',
        currentPassword: 'Faith2026!',
      })
      .expect(200);
    expect(updated.body.user).toMatchObject({
      fullName: 'Changed Name',
      email: 'changed@example.com',
    });

    // Changing the sign-in email signs out other devices and notifies the previous address.
    expect((await device2.get('/auth/me')).body.authenticated).toBe(false);
    await t.infra.queue.drain();
    expect(t.infra.email.sent.at(-1)).toMatchObject({
      to: 'change@example.com',
      subject: expect.stringContaining('email address was changed'),
    });
    await device2
      .post('/auth/login', {
        email: 'changed@example.com',
        password: 'Faith2026!',
      })
      .expect(200);

    const wrong = await device1
      .post('/auth/change-password', {
        currentPassword: 'Bad2026!x',
        newPassword: 'Better2026!',
      })
      .expect(422);
    expect(wrong.body).toMatchObject({
      code: 'WRONG_PASSWORD',
      errors: { currentPassword: [expect.any(String)] },
    });
    await device1
      .post('/auth/change-password', {
        currentPassword: 'Faith2026!',
        newPassword: 'Better2026!',
      })
      .expect(204);
    expect((await device1.get('/auth/me')).body.authenticated).toBe(true);
    expect((await device2.get('/auth/me')).body.authenticated).toBe(false);
    await new Client(t)
      .post('/auth/login', {
        email: 'changed@example.com',
        password: 'Better2026!',
      })
      .expect(200);
  });

  it('resets a forgotten password with a single-use token and no enumeration', async () => {
    await new Client(t)
      .post('/auth/register', {
        fullName: 'Reset',
        email: 'reset@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    await new Client(t)
      .post(
        '/auth/forgot-password',
        { email: 'nobody@example.com' },
        { 'Idempotency-Key': 'test-key-auth-0001' },
      )
      .expect(204);
    await new Client(t)
      .post(
        '/auth/forgot-password',
        { email: 'reset@example.com' },
        { 'Idempotency-Key': 'test-key-auth-0002' },
      )
      .expect(204);
    await t.infra.queue.drain();
    const resetEmails = t.infra.email.sent.filter((message) =>
      message.subject.includes('Reset'),
    );
    expect(resetEmails).toHaveLength(1);
    const token =
      new URL(
        /http\S+/.exec(resetEmails[0]?.text ?? '')?.[0] ?? '',
      ).searchParams.get('token') ?? '';

    await new Client(t)
      .post('/auth/reset-password', { token, password: 'Renewed2026!' })
      .expect(204);
    const reused = await new Client(t)
      .post('/auth/reset-password', { token, password: 'Again2026!x' })
      .expect(422);
    expect(reused.body).toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      errors: { token: [expect.any(String)] },
    });
    await new Client(t)
      .post('/auth/login', {
        email: 'reset@example.com',
        password: 'Renewed2026!',
      })
      .expect(200);
  });

  it('allows only one church per user and gates routes on onboarding', async () => {
    const client = new Client(t);
    await client
      .post('/auth/register', {
        fullName: 'Gate',
        email: 'gate@example.com',
        password: 'Faith2026!',
      })
      .expect(201);
    expect((await client.get('/sermons').expect(403)).body.code).toBe(
      'ONBOARDING_REQUIRED',
    );
    await client
      .post('/church', { name: 'Gate Church', ownerRole: 'Pastor' })
      .expect(201);
    expect(
      (
        await client
          .post('/church', { name: 'Second', ownerRole: 'Pastor' })
          .expect(409)
      ).body.code,
    ).toBe('CHURCH_EXISTS');
  });

  it('updates church preferences through PATCH /church with validation', async () => {
    const client = new Client(t);
    await client.onboard('Prefs Church');
    const bad = await client
      .patch('/church', { primaryColor: 'red', website: 'javascript:alert(1)' })
      .expect(422);
    expect(Object.keys(bad.body.errors)).toContain('primaryColor');
    const updated = await client
      .patch('/church', {
        primaryColor: '#B5502F',
        devotionalTone: 'Warm and pastoral',
        wordsToAvoid: 'hustle',
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      primaryColor: '#B5502F',
      devotionalTone: 'Warm and pastoral',
      wordsToAvoid: 'hustle',
    });
    await client.patch('/church', { country: 'NG' }).expect(422);

    const logo = Buffer.from('png-bytes');
    const presign = await client
      .post('/church/logo/presign', {
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: logo.length,
      })
      .expect(200);
    await client
      .post('/church/logo/presign', {
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 10,
      })
      .expect(422);
    t.infra.storage.put(presign.body.objectKey, logo, 'image/png');
    const withLogo = await client
      .patch('/church', { logoObjectKey: presign.body.objectKey })
      .expect(200);
    expect(withLogo.body.logoUrl).toMatch(/^memory:\/\/download\//);
  });
});
