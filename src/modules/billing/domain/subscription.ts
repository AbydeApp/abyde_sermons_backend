import { lagosMonthRange } from '../../../shared/domain/lagos-time.js';
import { PLANS, type Plan, type PlanId } from './plans.js';

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
  status: SubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
}

const PAST_DUE_GRACE_MS = 3 * 24 * 3600 * 1000;

/**
 * What a church may use right now. Paid plans apply while active (or non-renewing until period end,
 * or past due within a short grace window); otherwise the free plan applies per Lagos calendar month.
 */
export function entitlementFor(
  subscription: SubscriptionRecord | null,
  now: Date,
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
        plan: PLANS[subscription.planId],
        status: subscription.status,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      };
    }
    if (inGrace || (subscription.status === 'PAST_DUE' && inPeriod)) {
      return {
        plan: PLANS[subscription.planId],
        status: 'PAST_DUE',
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      };
    }
  }
  const month = lagosMonthRange(now);
  return {
    plan: PLANS.free,
    status: 'ACTIVE',
    periodStart: month.start,
    periodEnd: month.end,
  };
}
