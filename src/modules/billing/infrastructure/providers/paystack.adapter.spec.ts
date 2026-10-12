import { createHmac } from 'node:crypto';
import { PaystackAdapter } from './paystack.adapter.js';

describe('PaystackAdapter webhooks', () => {
  const adapter = new PaystackAdapter('sk_test_secret', {
    growth: 'PLN_growth',
  });
  const body = Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        id: 42,
        plan: { plan_code: 'PLN_growth' },
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
      planId: 'growth',
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
