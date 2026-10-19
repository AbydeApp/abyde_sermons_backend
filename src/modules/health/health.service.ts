import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../../shared/domain/domain-error.js';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import {
  CHECK_TIMEOUT_MS,
  READINESS_CHECKS,
  type ReadinessCheck,
  type ReadinessResponse,
  withTimeout,
} from './helper.js';

/** Dependency readiness and the pre-stop delay that lets load balancers stop routing traffic. */
@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthService.name);
  private draining = false;

  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<ReadinessResponse> {
    if (this.draining)
      throw new DomainError(
        'UNAVAILABLE',
        'NOT_READY',
        'Service is shutting down.',
      );

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
    if (results.some(([, state]) => state === 'down'))
      throw new DomainError(
        'UNAVAILABLE',
        'NOT_READY',
        'Service is not ready.',
      );

    return { status: 'ready', checks: Object.fromEntries(results) };
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    const delayMs = this.config.APP_SHUTDOWN_DRAIN_MS;
    // Only a real termination signal needs the pause (tests and scripts close immediately).
    if (!signal || delayMs === 0) return;
    this.logger.log({ signal, delayMs }, 'Draining before shutdown');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
