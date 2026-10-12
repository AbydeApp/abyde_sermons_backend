import type { UsageUnit } from '../../../../../shared/application/ports/usage-meter.port.js';

export const USAGE_QUERY = Symbol('USAGE_QUERY');

export interface UsageQueryPort {
  /** Sum of quantities for a unit within [from, to). */
  total(
    churchId: string,
    unit: UsageUnit,
    from: Date,
    to: Date,
  ): Promise<number>;
}
