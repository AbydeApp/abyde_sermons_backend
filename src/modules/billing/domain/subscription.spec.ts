import { entitlementFor, type SubscriptionRecord } from './subscription.js';

const subscription = (
  overrides: Partial<SubscriptionRecord>,
): SubscriptionRecord => ({
  id: 'sub',
  churchId: 'c1',
  provider: 'paystack',
  planId: 'growth',
  status: 'ACTIVE',
  externalSubscriptionId: 'SUB_1',
  externalEmailToken: null,
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});

describe('entitlementFor', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('uses the free plan per Lagos calendar month without a subscription', () => {
    const entitlement = entitlementFor(null, now);
    expect(entitlement.plan.id).toBe('free');
    expect(entitlement.periodStart.toISOString()).toBe(
      '2026-09-30T23:00:00.000Z',
    );
    expect(entitlement.periodEnd.toISOString()).toBe(
      '2026-10-31T23:00:00.000Z',
    );
  });

  it('applies paid plans while active or non-renewing within the period', () => {
    expect(entitlementFor(subscription({}), now).plan.id).toBe('growth');
    expect(
      entitlementFor(subscription({ status: 'NON_RENEWING' }), now).plan.id,
    ).toBe('growth');
    expect(
      entitlementFor(
        subscription({ status: 'NON_RENEWING' }),
        new Date('2026-11-02T00:00:00Z'),
      ).plan.id,
    ).toBe('free');
  });

  it('gives past-due subscriptions a short grace period', () => {
    expect(
      entitlementFor(
        subscription({ status: 'PAST_DUE' }),
        new Date('2026-11-02T00:00:00Z'),
      ),
    ).toMatchObject({ status: 'PAST_DUE', plan: { id: 'growth' } });
    expect(
      entitlementFor(
        subscription({ status: 'PAST_DUE' }),
        new Date('2026-11-05T00:00:00Z'),
      ).plan.id,
    ).toBe('free');
  });

  it('drops cancelled subscriptions to free', () => {
    expect(
      entitlementFor(subscription({ status: 'CANCELLED' }), now).plan.id,
    ).toBe('free');
  });
});
