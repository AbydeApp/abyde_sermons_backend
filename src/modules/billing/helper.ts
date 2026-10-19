export type PlanId = 'standard';

/** Feature limits per plan. Data-driven: every plan check reads this table, never a plan id. */
export interface PlanFeatures {
  /** Days the original sermon upload is kept; transcripts and generated media are kept. */
  sourceRetentionDays: number;
}

export interface Plan extends PlanFeatures {
  id: PlanId;
  name: string;
  /** Monthly price in kobo (₦1 = 100 kobo). */
  priceKobo: number;
  sermonsPerPeriod: number;
}

/** Customer-facing allowances are counted in sermons, never tokens. */
export const PLANS: Record<PlanId, Plan> = {
  standard: {
    id: 'standard',
    name: 'Standard',
    priceKobo: 700_000,
    sermonsPerPeriod: 15,
    sourceRetentionDays: 14,
  },
};
export const PAID_PLAN_IDS = ['standard'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export const isPlanId = (value: string): value is PlanId =>
  value === 'standard';

/** Same day next calendar month, clamped for shorter months. */
export function nextMonth(start: Date): Date {
  const end = new Date(start);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), last));
  return end;
}

export function priceLabel(plan: Plan): string {
  if (plan.priceKobo === 0) return 'Free';
  return `₦${(plan.priceKobo / 100).toLocaleString('en-NG')} / month`;
}

export type SubscriptionStatus =
  'ACTIVE' | 'NON_RENEWING' | 'PAST_DUE' | 'CANCELLED';

export interface SubscriptionRecord {
  id: string;
  churchId: string;
  provider: string;
  planId: PlanId;
  status: SubscriptionStatus;
  externalSubscriptionId: string | null;
  externalEmailToken: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export interface Entitlement {
  plan: Plan;
  status: SubscriptionStatus | 'TRIALING' | 'EXPIRED';
  active: boolean;
  periodStart: Date;
  periodEnd: Date;
}

const PAST_DUE_GRACE_MS = 3 * 24 * 3600 * 1000;

/**
 * What a church may use right now. Paid plans apply while active (or non-renewing until period end,
 * or past due within a short grace window); otherwise access expires. A church without a subscription gets one trial month from creation.
 */
export function entitlementFor(
  subscription: SubscriptionRecord | null,
  now: Date,
  churchCreatedAt?: Date | null,
): Entitlement {
  if (subscription) {
    const end = subscription.currentPeriodEnd.getTime();
    const inPeriod = now.getTime() < end;
    const inGrace =
      subscription.status === 'PAST_DUE' &&
      now.getTime() < end + PAST_DUE_GRACE_MS;
    if (
      (subscription.status === 'ACTIVE' ||
        subscription.status === 'NON_RENEWING') &&
      inPeriod
    ) {
      return {
        plan: PLANS.standard,
        active: true,
        status: subscription.status,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      };
    }
    if (inGrace || (subscription.status === 'PAST_DUE' && inPeriod)) {
      return {
        plan: PLANS.standard,
        active: true,
        status: 'PAST_DUE',
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      };
    }
  }
  const periodStart =
    subscription?.currentPeriodStart ?? churchCreatedAt ?? now;
  const periodEnd =
    subscription?.currentPeriodEnd ??
    (churchCreatedAt ? nextMonth(churchCreatedAt) : now);
  const trialing =
    !subscription &&
    !!churchCreatedAt &&
    now >= churchCreatedAt &&
    now < periodEnd;
  return {
    plan: PLANS.standard,
    active: trialing,
    status: trialing
      ? 'TRIALING'
      : subscription?.status === 'CANCELLED'
        ? 'CANCELLED'
        : 'EXPIRED',
    periodStart,
    periodEnd,
  };
}
