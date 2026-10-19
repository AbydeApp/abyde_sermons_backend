import {
  entitlementFor,
  nextMonth,
  PLANS,
  priceLabel,
  type SubscriptionRecord,
} from './helper.js';

const subscription = (
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord => ({
  id: 'sub',
  churchId: 'c1',
  provider: 'paystack',
  planId: 'standard',
  status: 'ACTIVE',
  externalSubscriptionId: 'SUB_1',
  externalEmailToken: null,
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});

describe('Standard billing rules', () => {
  const start = new Date('2026-10-05T09:00:00Z');
  it('offers exactly one plan at ₦7,000 with 15 sermons', () => {
    expect(Object.keys(PLANS)).toEqual(['standard']);
    expect(PLANS.standard).toMatchObject({
      priceKobo: 700_000,
      sermonsPerPeriod: 15,
    });
    expect(priceLabel(PLANS.standard)).toBe('₦7,000 / month');
  });
  it('anchors the free month to church creation, never the current request', () => {
    for (const now of [start, new Date('2026-11-05T08:59:59Z')]) {
      expect(entitlementFor(null, now, start)).toMatchObject({
        active: true,
        status: 'TRIALING',
        periodStart: start,
        periodEnd: new Date('2026-11-05T09:00:00Z'),
      });
    }
    for (const now of [
      new Date('2026-11-05T09:00:00Z'),
      new Date('2027-10-05T09:00:00Z'),
    ]) {
      expect(entitlementFor(null, now, start)).toMatchObject({
        active: false,
        status: 'EXPIRED',
        periodEnd: new Date('2026-11-05T09:00:00Z'),
      });
    }
    expect(entitlementFor(null, start).active).toBe(false);
  });
  it('clamps end-of-month anniversaries, including leap years', () => {
    expect(nextMonth(new Date('2026-01-31T09:00:00Z')).toISOString()).toBe(
      '2026-02-28T09:00:00.000Z',
    );
    expect(nextMonth(new Date('2028-01-31T09:00:00Z')).toISOString()).toBe(
      '2028-02-29T09:00:00.000Z',
    );
  });
  it('honours paid periods and non-renewing access until the exact expiry', () => {
    for (const status of ['ACTIVE', 'NON_RENEWING'] as const) {
      expect(entitlementFor(subscription({ status }), start).active).toBe(true);
      expect(
        entitlementFor(
          subscription({ status }),
          new Date('2026-11-01T00:00:00Z'),
        ),
      ).toMatchObject({ active: false, status: 'EXPIRED' });
    }
  });
  it('allows three days of grace for failed renewals', () => {
    expect(
      entitlementFor(
        subscription({ status: 'PAST_DUE' }),
        new Date('2026-11-03T23:59:59Z'),
      ).active,
    ).toBe(true);
    expect(
      entitlementFor(
        subscription({ status: 'PAST_DUE' }),
        new Date('2026-11-04T00:00:00Z'),
      ).active,
    ).toBe(false);
  });
  it('does not restart a trial after cancellation', () => {
    expect(
      entitlementFor(subscription({ status: 'CANCELLED' }), start, start),
    ).toMatchObject({ active: false, status: 'CANCELLED' });
  });
});
