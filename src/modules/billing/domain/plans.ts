export type PlanId = 'free' | 'starter' | 'growth' | 'ministry';

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
  free: {
    id: 'free',
    name: 'Free',
    priceKobo: 0,
    sermonsPerPeriod: 2,
    sourceRetentionDays: 3,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceKobo: 1_000_000,
    sermonsPerPeriod: 6,
    sourceRetentionDays: 3,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceKobo: 2_500_000,
    sermonsPerPeriod: 15,
    sourceRetentionDays: 14,
  },
  ministry: {
    id: 'ministry',
    name: 'Ministry',
    priceKobo: 5_000_000,
    sermonsPerPeriod: 40,
    sourceRetentionDays: 30,
  },
};

export const PAID_PLAN_IDS = ['starter', 'growth', 'ministry'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export const isPlanId = (value: string): value is PlanId => value in PLANS;

export function priceLabel(plan: Plan): string {
  if (plan.priceKobo === 0) return 'Free';
  return `₦${(plan.priceKobo / 100).toLocaleString('en-NG')} / month`;
}
