export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

export interface ReadinessCheck {
  readonly name: string;
  /** Resolves when the dependency can serve traffic; rejects otherwise. */
  check(): Promise<void>;
}

export interface ReadinessResponse {
  status: 'ready';
  checks: Record<string, 'up' | 'down'>;
}

export const CHECK_TIMEOUT_MS = 2_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
