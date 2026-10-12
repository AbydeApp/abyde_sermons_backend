import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../../shared/infrastructure/config/env.schema.js';

/**
 * On SIGTERM the instance first reports "not ready" and keeps serving for a short pre-stop delay,
 * so the load balancer stops routing to it before the server closes. The delay counts against the
 * platform's termination grace period.
 */
@Injectable()
export class ShutdownDrain implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownDrain.name);
  private draining = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get isDraining(): boolean {
    return this.draining;
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
