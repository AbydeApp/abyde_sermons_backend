import { createHmac } from 'node:crypto';
import { PaystackAdapter } from './paystack.adapter.js';

describe('PaystackAdapter webhooks', () => {
  const adapter = new PaystackAdapter('sk_test_secret', {
    standard: 'PLN_standard',
  });
  const body = Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        id: 42,
        plan: { plan_code: 'PLN_standard' },
        customer: { customer_code: 'CUS_1', email: 'p@x.com' },
        metadata: { churchId: '11111111-1111-1111-1111-111111111111' },
      },
    }),
  );
  const signature = createHmac('sha512', 'sk_test_secret')
    .update(body)
    .digest('hex');

  it('verifies HMAC-SHA512 signatures over the raw body', () => {
    expect(
      adapter.verifySignature(body, { 'x-paystack-signature': signature }),
    ).toBe(true);
    expect(
      adapter.verifySignature(
        Buffer.from(body.toString().replace('42', '43')),
        { 'x-paystack-signature': signature },
      ),
    ).toBe(false);
    expect(adapter.verifySignature(body, {})).toBe(false);
    expect(
      adapter.verifySignature(body, { 'x-paystack-signature': 'zz' }),
    ).toBe(false);
  });

  it('normalises events and derives a stable event id for replay protection', () => {
    const event = adapter.parseEvent(body);
    expect(event).toMatchObject({
      kind: 'PAYMENT_SUCCEEDED',
      planId: 'standard',
      customerCode: 'CUS_1',
      churchId: '11111111-1111-1111-1111-111111111111',
    });
    expect(adapter.parseEvent(body).eventId).toBe(event.eventId);
    expect(
      adapter.parseEvent(
        Buffer.from(JSON.stringify({ event: 'transfer.success', data: {} })),
      ).kind,
    ).toBe('IGNORED');
  });

  it('ignores a churchId that is not a UUID', () => {
    const forged = Buffer.from(
      JSON.stringify({
        event: 'charge.success',
        data: { metadata: { churchId: "1' OR '1'='1" } },
      }),
    );
    expect(adapter.parseEvent(forged).churchId).toBeNull();
  });
});

describe('Paystack Standard checkout', () => {
  afterEach(() => vi.unstubAllGlobals());
  const input = {
    churchId: 'church',
    email: 'test@example.com',
    planId: 'standard' as const,
    amountKobo: 700_000,
    callbackUrl: 'https://web.test/billing',
  };
  it('checks the provider price and billing interval before creating checkout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: true,
            data: { amount: 700_000, currency: 'NGN', interval: 'monthly' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: true,
            data: { authorization_url: 'https://checkout.paystack.com/test' },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new PaystackAdapter('sk_test', {
      standard: 'PLN_standard',
    });
    expect(await adapter.createCheckout(input)).toEqual({
      url: 'https://checkout.paystack.com/test',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.paystack.co/plan/PLN_standard',
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      amount: 700_000,
      currency: 'NGN',
      plan: 'PLN_standard',
    });
  });
  it.each([
    { amount: 2_500_000, currency: 'NGN', interval: 'monthly' },
    { amount: 700_000, currency: 'USD', interval: 'monthly' },
    { amount: 700_000, currency: 'NGN', interval: 'annually' },
  ])('refuses a mismatched provider plan: %j', async (data) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: true, data })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new PaystackAdapter('sk_test', {
        standard: 'PLN_standard',
      }).createCheckout(input),
    ).rejects.toThrow('NGN 7000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
