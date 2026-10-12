import request from 'supertest';
import { FakePaymentAdapter } from '../src/modules/billing/infrastructure/providers/fake-payment.adapter.js';
import { Client, createTestApp, type TestApp } from './support/test-app.js';

describe('billing, plan limits and webhooks (e2e)', () => {
  let t: TestApp;
  let client: Client;
  let churchId: string;

  const sendWebhook = (event: object, signature?: string) => {
    const raw = JSON.stringify(event);
    return request(t.app.getHttpServer())
      .post('/api/v1/webhooks/billing/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', signature ?? FakePaymentAdapter.sign(raw))
      .send(raw);
  };

  beforeAll(async () => {
    t = await createTestApp();
    client = new Client(t);
    churchId = await client.onboard('Billing Church');
  });
  afterAll(() => t.close());

  it('starts on the free plan with customer-friendly usage', async () => {
    const subscription = await client.get('/billing/subscription').expect(200);
    expect(subscription.body).toEqual({
      planId: 'free',
      planName: 'Free',
      priceLabel: 'Free',
      status: 'ACTIVE',
      currentPeriodEnd: '2026-10-31T23:00:00.000Z',
      features: {
        reelsPerPeriod: 0,
        reelHooks: false,
        animatedCaptions: false,
        priorityProcessing: false,
        sourceRetentionDays: 3,
      },
    });
    const usage = await client.get('/billing/usage').expect(200);
    expect(usage.body).toEqual({
      sermonsUsed: 0,
      sermonsLimit: 2,
      contentGenerated: 0,
      reelsUsed: 0,
      reelsLimit: 0,
      periodEnd: '2026-10-31T23:00:00.000Z',
    });
  });

  it('enforces the sermon allowance', async () => {
    await client.createSermon('One');
    await client.createSermon('Two');
    const audio = Buffer.from('x');
    const presign = await client
      .post('/uploads/presign', {
        fileName: 'c.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 1,
        purpose: 'SERMON_MEDIA',
      })
      .expect(200);
    t.infra.storage.put(presign.body.objectKey, audio, 'audio/mpeg');
    const blocked = await client
      .post('/sermons', {
        title: 'Three',
        speaker: 'S',
        sermonDate: '2026-09-27T09:00:00Z',
        objectKey: presign.body.objectKey,
      })
      .expect(402);
    expect(blocked.body.code).toBe('PLAN_LIMIT_REACHED');
    // The upload was not consumed by the rejected request (transaction rolled back), so it can be retried after upgrading.
    expect(
      [...t.infra.db.uploads.values()].find(
        (u) => u.objectKey === presign.body.objectKey,
      )?.consumedAt,
    ).toBeNull();
  });

  it('creates checkout and portal links (never trusting client payment status)', async () => {
    const checkout = await client
      .post(
        '/billing/checkout',
        { planId: 'starter' },
        { 'Idempotency-Key': 'test-key-bill-0001' },
      )
      .expect(200);
    expect(checkout.body.url).toBe(
      'http://web.test/billing?mockCheckout=starter',
    );
    const portal = await client
      .post(
        '/billing/portal',
        {},
        { 'Idempotency-Key': 'test-key-portal-0002' },
      )
      .expect(200);
    expect(portal.body.url).toContain('mockCheckout=growth');
    expect((await client.get('/billing/subscription')).body.planId).toBe(
      'free',
    );
  });

  it('rejects webhooks with a bad signature', async () => {
    const response = await sendWebhook(
      {
        id: 'evt-bad',
        type: 'charge.success',
        kind: 'PAYMENT_SUCCEEDED',
        amountKobo: 2_500_000,
        currency: 'NGN',
        churchId,
        planId: 'growth',
      },
      'deadbeef',
    ).expect(401);
    expect(response.body.code).toBe('INVALID_SIGNATURE');
    expect((await client.get('/billing/subscription')).body.planId).toBe(
      'free',
    );
  });

  it('ignores a successful charge that does not cover the plan price', async () => {
    await sendWebhook({
      id: 'evt-cheap',
      type: 'charge.success',
      kind: 'PAYMENT_SUCCEEDED',
      churchId,
      planId: 'ministry',
      amountKobo: 10_000,
      currency: 'NGN',
    }).expect(200);
    await sendWebhook({
      id: 'evt-usd',
      type: 'charge.success',
      kind: 'PAYMENT_SUCCEEDED',
      churchId,
      planId: 'growth',
      amountKobo: 2_500_000,
      currency: 'USD',
    }).expect(200);
    expect((await client.get('/billing/subscription')).body.planId).toBe(
      'free',
    );
  });

  it('activates a subscription from a verified webhook and is replay-safe', async () => {
    const event = {
      id: 'evt-1',
      type: 'charge.success',
      kind: 'PAYMENT_SUCCEEDED',
      amountKobo: 2_500_000,
      currency: 'NGN',
      churchId,
      customerCode: 'CUS_1',
      planId: 'growth',
      subscriptionCode: 'SUB_1',
      nextPaymentDate: '2026-11-05T09:00:00.000Z',
    };
    await sendWebhook(event).expect(200);
    await sendWebhook(event).expect(200);
    const subscription = await client.get('/billing/subscription').expect(200);
    expect(subscription.body).toMatchObject({
      planId: 'growth',
      planName: 'Growth',
      priceLabel: '₦25,000 / month',
      status: 'ACTIVE',
      currentPeriodEnd: '2026-11-05T09:00:00.000Z',
    });
    expect((await client.get('/billing/usage')).body.sermonsLimit).toBe(15);
    expect(t.infra.db.webhookEvents.has('fake:evt-1')).toBe(true);
    expect(t.infra.db.allowances.get(churchId)).toMatchObject({
      planId: 'growth',
      sermonsLimit: 15,
    });

    const portal = await client
      .post(
        '/billing/portal',
        {},
        { 'Idempotency-Key': 'test-key-portal-0003' },
      )
      .expect(200);
    expect(portal.body.url).toContain('mockManage=SUB_1');
  });

  it('maps later lifecycle events by customer, and retries unknown customers', async () => {
    await sendWebhook({
      id: 'evt-2',
      type: 'subscription.not_renew',
      kind: 'SUBSCRIPTION_NOT_RENEWING',
      customerCode: 'CUS_1',
    }).expect(200);
    expect((await client.get('/billing/subscription')).body.status).toBe(
      'NON_RENEWING',
    );
    const unknown = await sendWebhook({
      id: 'evt-3',
      type: 'subscription.disable',
      kind: 'SUBSCRIPTION_DISABLED',
      customerCode: 'CUS_UNKNOWN',
    }).expect(503);
    expect(unknown.body.code).toBe('RETRY_LATER');
    expect(t.infra.db.webhookEvents.has('fake:evt-3')).toBe(false); // not recorded, so the redelivery is processed

    t.infra.clock.set('2026-11-06T09:00:00Z');
    await client.login(); // a month later the earlier session has expired
    expect((await client.get('/billing/subscription')).body.planId).toBe(
      'free',
    );
  });
});
