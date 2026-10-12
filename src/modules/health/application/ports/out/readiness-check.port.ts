export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

export interface ReadinessCheckPort {
  readonly name: string;
  /** Resolves when the dependency can serve traffic; rejects otherwise. */
  check(): Promise<void>;
}
