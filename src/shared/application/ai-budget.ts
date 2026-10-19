import type { CachePort } from './ports/cache.port.js';
import { DomainError } from '../domain/domain-error.js';

/**
 * Per-church ceilings on user-triggered AI work, on top of the per-IP HTTP throttles. They bound
 * what one account can spend on paid model calls regardless of how many IPs it uses.
 */
export const AI_BUDGETS = {
  /** Rewrites and regenerations of single items. */
  edit: { limit: 120, windowSeconds: 3600 },
  /** "Generate My Week" requests (each fans out to up to eight model calls). */
  generateWeek: { limit: 30, windowSeconds: 3600 },
} as const;

export async function assertAIBudget(
  cache: CachePort,
  churchId: string,
  kind: keyof typeof AI_BUDGETS,
): Promise<void> {
  const budget = AI_BUDGETS[kind];
  const used = await cache.increment(
    `ai-budget:${kind}:${churchId}`,
    budget.windowSeconds,
  );
  if (used > budget.limit) {
    throw new DomainError(
      'RATE_LIMITED',
      'AI_LIMIT_REACHED',
      "You've reached the hourly limit for AI generation. Please try again later.",
    );
  }
}
