import { Client, createTestApp, type TestApp } from './support/test-app.js';

const PASSWORD = 'Faith2026!';

describe('authentication (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** Registers (which also creates the church) without verifying. */
  async function register(email: string, extra: object = {}) {
    const client = new Client(t);
    client.email = email;
    await client
      .post('/auth/register', {
        fullName: 'Test User',
        email,
        password: PASSWORD,
        ...extra,
      })
      .expect(201);
    return client;
  }

  /** Registers and confirms the email, leaving a signed-in client. */
  async function signUp(email: string, extra: object = {}) {
    const client = await register(email, extra);
    await client.verifyEmail();
    return client;
  }

  async function lastCode(email: string): Promise<string> {
    await t.infra.queue.drain();
    const mail = t.infra.email.sent.filter((m) => m.to === email).at(-1);
    return /code is (\d{6})/.exec(mail?.text ?? '')?.[1] ?? '';
  }

  it('returns a signed-out Me with 200', async () => {
    const response = await new Client(t).get('/auth/me').expect(200);
    expect(response.body).toEqual({
      authenticated: false,
      user: null,
      church: null,
    });
  });

  it('normalises emails and rejects a verified duplicate with EMAIL_TAKEN', async () => {
    await signUp('dup@example.com');
    const duplicate = await new Client(t)
      .post('/auth/register', {
        fullName: 'Two',
        email: '  DUP@example.COM ',
        password: PASSWORD,
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

  it('gives no tokens until the emailed code is confirmed, and creates the church at signup', async () => {
    const client = new Client(t);
    client.email = 'verify@example.com';
    const registered = await client
      .post('/auth/register', {
        fullName: 'Verify',
        email: 'verify@example.com',
        password: PASSWORD,
        churchName: 'Verify Church',
      })
      .expect(201);
    expect(registered.body).toEqual({ email: 'verify@example.com' });

    const blocked = await client
      .post('/auth/login', { email: 'verify@example.com', password: PASSWORD })
      .expect(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');
    await client.get('/sermons').expect(401);

    const wrong = await client
      .post('/auth/verify-email', { email: 'verify@example.com', code: '000000' })
      .expect(422);
    expect(wrong.body.code).toBe('OTP_INVALID');

    const verified = await client
      .post('/auth/verify-email', {
        email: 'verify@example.com',
        code: await lastCode('verify@example.com'),
      })
      .expect(200);
    expect(verified.body).toMatchObject({
      authenticated: true,
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(Number),
      user: { email: 'verify@example.com', phoneNumber: null },
      church: { name: 'Verify Church', slug: 'verify-church' },
    });
    expect(JSON.stringify(verified.body)).not.toMatch(/hash/i);
    expect((await client.get('/auth/me')).body.authenticated).toBe(true);
    // The code is single-use.
    await client
      .post('/auth/verify-email', {
        email: 'verify@example.com',
        code: await lastCode('verify@example.com'),
      })
      .expect(422);
  });

  it('locks a code after too many wrong guesses and rejects an expired one', async () => {
    const locked = await register('otp-lock@example.com');
    const code = await lastCode('otp-lock@example.com');
    for (let i = 0; i < 5; i++)
      await locked
        .post('/auth/verify-email', { email: 'otp-lock@example.com', code: '000000' })
        .expect(422);
    const lockedOut = await locked
      .post('/auth/verify-email', { email: 'otp-lock@example.com', code })
      .expect(429);
    expect(lockedOut.body.code).toBe('OTP_LOCKED');

    const stale = await register('otp-old@example.com');
    const oldCode = await lastCode('otp-old@example.com');
    t.infra.clock.advance(11 * 60_000);
    const expired = await stale
      .post('/auth/verify-email', { email: 'otp-old@example.com', code: oldCode })
      .expect(422);
    expect(expired.body.code).toBe('OTP_EXPIRED');
  });

  it('resend-verification answers the same for unknown and unverified accounts', async () => {
    await register('resend@example.com');
    const client = new Client(t);
    await client
      .post('/auth/resend-verification', { email: 'resend@example.com' })
      .expect(204);
    await client
      .post('/auth/resend-verification', { email: 'nobody@example.com' })
      .expect(204);
  });

  it('lets an abandoned, unverified signup be registered again', async () => {
    await register('retry@example.com');
    const second = await register('retry@example.com', { fullName: 'Second Try' });
    t.infra.clock.advance(61_000); // the one-code-per-minute throttle
    await t.infra.cache.del(
      ...[...t.infra.db.users.values()].map((u) => `otp-sent:${u.id}`),
    );
    await second.post('/auth/resend-verification', { email: 'retry@example.com' });
    const me = await second.verifyEmail();
    expect(me.body.user.fullName).toBe('Second Try');
  });

  it('logs in, gives generic errors and never returns the password hash', async () => {
    await signUp('login@example.com');
    const wrongPassword = await new Client(t)
      .post('/auth/login', { email: 'login@example.com', password: 'Nope2026!' })
      .expect(401);
    const unknownEmail = await new Client(t)
      .post('/auth/login', { email: 'ghost@example.com', password: 'Nope2026!' })
      .expect(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);

    const client = new Client(t);
    const ok = await client
      .post('/auth/login', {
        email: 'LOGIN@example.com',
        password: PASSWORD,
        remember: true,
      })
      .expect(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/hash/i);
    expect(ok.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    // "Remember me" lengthens the refresh token's life, not the access token's.
    const remembered = [...t.infra.db.sessions.values()].at(-1);
    expect(
      (remembered?.expiresAt.getTime() ?? 0) - t.infra.clock.now().getTime(),
    ).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect((await client.get('/auth/me')).body.authenticated).toBe(true);
  });

  it('locks out repeated failures for one email', async () => {
    await signUp('lock@example.com');
    for (let i = 0; i < 10; i++)
      await new Client(t).post('/auth/login', {
        email: 'lock@example.com',
        password: 'Wrong2026!',
      });
    const locked = await new Client(t)
      .post('/auth/login', { email: 'lock@example.com', password: PASSWORD })
      .expect(429);
    expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('rotates the refresh token and rejects a replayed one', async () => {
    const client = await signUp('rotate@example.com');
    const first = client.refreshToken;
    const rotated = await new Client(t)
      .post('/auth/refresh', { refreshToken: first })
      .expect(200);
    expect(rotated.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(Number),
    });
    expect(rotated.body.refreshToken).not.toBe(first);
    const replay = await new Client(t)
      .post('/auth/refresh', { refreshToken: first })
      .expect(401);
    expect(replay.body.code).toBe('INVALID_REFRESH_TOKEN');
    await new Client(t)
      .post('/auth/refresh', { refreshToken: rotated.body.refreshToken })
      .expect(200);
  });

  it('logs out by revoking the session (idempotently)', async () => {
    const client = await signUp('out@example.com');
    const { refreshToken } = client;
    const access = (client as unknown as { accessToken: string }).accessToken;
    await client.post('/auth/logout', { refreshToken }).expect(204);
    await client.post('/auth/logout', { refreshToken }).expect(204);
    await client.post('/auth/logout', {}).expect(204);
    // The access token is cut off at once and the refresh token no longer works.
    expect((await client.get('/auth/me')).body.authenticated).toBe(false);
    expect(access).toBeTruthy();
    await new Client(t).post('/auth/refresh', { refreshToken }).expect(401);
  });

  it('expires access tokens quickly but lets the refresh token renew them', async () => {
    const short = await createTestApp({ AUTH_ACCESS_TOKEN_TTL_MINUTES: '15' });
    try {
      const client = new Client(short);
      client.email = 'expire@example.com';
      await client
        .post('/auth/register', {
          fullName: 'Exp',
          email: 'expire@example.com',
          password: PASSWORD,
        })
        .expect(201);
      await client.verifyEmail();
      await client.get('/sermons').expect(200);
      short.infra.clock.advance(16 * 60_000);
      await client.get('/sermons').expect(401);
      const renewed = await client
        .post('/auth/refresh', { refreshToken: client.refreshToken })
        .expect(200);
      expect(renewed.body.accessToken).toEqual(expect.any(String));
      // Tokens older than the session lifetime cannot be refreshed.
      short.infra.clock.advance(25 * 3600 * 1000);
      await new Client(short)
        .post('/auth/refresh', { refreshToken: renewed.body.refreshToken })
        .expect(401);
    } finally {
      await short.close();
    }
  });

  it('updates the profile and changes password (other sessions are signed out)', async () => {
    const device1 = await signUp('change@example.com');
    const device2 = new Client(t);
    await device2
      .post('/auth/login', { email: 'change@example.com', password: PASSWORD })
      .expect(200);

    const named = await device1
      .patch('/auth/me', { fullName: 'Changed Name', phoneNumber: '+234 801 234 5678' })
      .expect(200);
    expect(named.body.user).toMatchObject({
      fullName: 'Changed Name',
      phoneNumber: '+234 801 234 5678',
    });
    const badPhone = await device1
      .patch('/auth/me', { phoneNumber: 'abc' })
      .expect(422);
    expect(badPhone.body.errors.phoneNumber).toBeDefined();
    expect(
      (await device1.patch('/auth/me', { phoneNumber: '' }).expect(200)).body.user
        .phoneNumber,
    ).toBeNull();

    expect((await device2.get('/auth/me')).body.authenticated).toBe(true);
    const updated = await device1
      .patch('/auth/me', { email: 'changed@example.com' })
      .expect(200);
    expect(updated.body.user.email).toBe('changed@example.com');

    // Changing the sign-in email signs out other devices and notifies the previous address.
    expect((await device2.get('/auth/me')).body.authenticated).toBe(false);
    expect((await device1.get('/auth/me')).body.authenticated).toBe(true);
    await t.infra.queue.drain();
    expect(t.infra.email.sent.at(-1)).toMatchObject({
      to: 'change@example.com',
      subject: expect.stringContaining('email address was changed'),
    });
    await device2
      .post('/auth/login', { email: 'changed@example.com', password: PASSWORD })
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
        currentPassword: PASSWORD,
        newPassword: 'Better2026!',
      })
      .expect(204);
    expect((await device1.get('/auth/me')).body.authenticated).toBe(true);
    expect((await device2.get('/auth/me')).body.authenticated).toBe(false);
    await new Client(t)
      .post('/auth/login', { email: 'changed@example.com', password: 'Better2026!' })
      .expect(200);
  });

  it('resets a forgotten password with a single-use token and no enumeration', async () => {
    await signUp('reset@example.com');
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
      .post('/auth/login', { email: 'reset@example.com', password: 'Renewed2026!' })
      .expect(200);
  });

  it('creates one church per account at signup and gates routes on it', async () => {
    const named = await signUp('gate@example.com', { churchName: 'Gate Church' });
    expect((await named.get('/church').expect(200)).body).toMatchObject({
      name: 'Gate Church',
      slug: 'gate-church',
      ownerRole: 'Owner',
    });
    await named.post('/church', { name: 'Second', ownerRole: 'Pastor' }).expect(404);

    const unnamed = await signUp('gate2@example.com');
    expect((await unnamed.get('/church').expect(200)).body.name).toBe(
      'Your Ministry',
    );
    // Two churches with the same name get distinct slugs.
    await signUp('gate3@example.com', { churchName: 'Gate Church' });
    const slugs = [...t.infra.db.churches.values()].map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
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
    // Logos live in Brand Studio, not on the church profile.
    await client.patch('/church', { logoObjectKey: 'x' }).expect(422);
  });
});
