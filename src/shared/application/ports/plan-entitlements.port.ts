export const PLAN_ENTITLEMENTS = Symbol('PLAN_ENTITLEMENTS');

/**
 * What the church's current plan allows in the period running now. Implemented by billing (the
 * single place plan rules live); other modules read limits from here instead of checking plan ids.
 */
export interface PlanAllowance {
  planId: string;
  planName: string;
  periodStart: Date;
  periodEnd: Date;
  reelsPerPeriod: number;
  /** Reels whose render completed in this period. */
  reelsUsed: number;
  reelHooks: boolean;
  animatedCaptions: boolean;
  priorityProcessing: boolean;
  sourceRetentionDays: number;
}

export interface PlanEntitlementsPort {
  allowance(churchId: string): Promise<PlanAllowance>;
}
