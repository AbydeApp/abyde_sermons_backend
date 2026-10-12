export type PlanId = 'free' | 'starter' | 'growth' | 'ministry';

/** Feature limits per plan. Data-driven: every plan check reads this table, never a plan id. */
export interface PlanFeatures {
  /** Reels rendered per billing period; 0 means the plan has no Reel rendering. */
  reelsPerPeriod: number;
  /** AI hook copy for Reels. */
  reelHooks: boolean;
  /** Animated caption styles (anything but CLEAN) and hook animations. */
  animatedCaptions: boolean;
  /** Renders jump ahead of lower plans in the render queue. */
  priorityProcessing: boolean;
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

/** Customer-facing allowances are counted in sermons and Reels, never tokens. */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceKobo: 0,
    sermonsPerPeriod: 2,
    reelsPerPeriod: 0,
    reelHooks: false,
    animatedCaptions: false,
    priorityProcessing: false,
    sourceRetentionDays: 3,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceKobo: 1_000_000,
    sermonsPerPeriod: 6,
    reelsPerPeriod: 0,
    reelHooks: false,
    animatedCaptions: false,
    priorityProcessing: false,
    sourceRetentionDays: 3,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceKobo: 2_500_000,
    sermonsPerPeriod: 15,
    reelsPerPeriod: 8,
    reelHooks: true,
    animatedCaptions: true,
    priorityProcessing: false,
    sourceRetentionDays: 14,
  },
  ministry: {
    id: 'ministry',
    name: 'Ministry',
    priceKobo: 5_000_000,
    sermonsPerPeriod: 40,
    reelsPerPeriod: 24,
    reelHooks: true,
    animatedCaptions: true,
    priorityProcessing: true,
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
