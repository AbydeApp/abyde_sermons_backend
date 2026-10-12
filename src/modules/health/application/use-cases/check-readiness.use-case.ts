import { Inject, Injectable } from '@nestjs/common';
import {
  READINESS_CHECKS,
  type ReadinessCheckPort,
} from '../ports/out/readiness-check.port.js';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, 'up' | 'down'>;
}

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class CheckReadinessUseCase {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheckPort[],
  ) {}

  async execute(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (probe) => {
        try {
          await withTimeout(probe.check(), CHECK_TIMEOUT_MS);
          return [probe.name, 'up'] as const;
        } catch {
          return [probe.name, 'down'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results) as Record<string, 'up' | 'down'>;
    return { ready: results.every(([, state]) => state === 'up'), checks };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
