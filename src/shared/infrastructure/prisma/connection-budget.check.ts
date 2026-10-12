import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { PrismaService } from './prisma.service.js';

/** Connections left for superusers, migrations run by hand and monitoring. */
const RESERVED_CONNECTIONS = 5;

/** Pool size × peak process count must fit inside Postgres `max_connections`. */
export function connectionBudget(
  poolMax: number,
  processes: number,
  maxConnections: number,
) {
  const needed = poolMax * processes;
  return {
    needed,
    available: maxConnections - RESERVED_CONNECTIONS,
    fits: needed <= maxConnections - RESERVED_CONNECTIONS,
  };
}

/**
 * Verifies the connection budget against the real database at boot. `DATABASE_EXPECTED_PROCESSES`
 * is the peak number of processes holding a pool: API replicas + worker replicas + the migration
 * job, doubled for the old/new overlap during a rolling deploy.
 */
@Injectable()
export class ConnectionBudgetCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConnectionBudgetCheck.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const processes = this.config.DATABASE_EXPECTED_PROCESSES;
    if (processes === undefined) return; // only enforced where it is configured (required when deployed)
    const rows = await this.prisma.client.$queryRaw<
      Array<{ max_connections: string }>
    >`SHOW max_connections`;
    const maxConnections = Number(rows[0]?.max_connections ?? 0);
    const budget = connectionBudget(
      this.config.DATABASE_POOL_MAX,
      processes,
      maxConnections,
    );
    if (budget.fits) return;
    const message = `Connection budget exceeded: pool ${this.config.DATABASE_POOL_MAX} × ${processes} processes = ${budget.needed}, but only ${budget.available} of max_connections ${maxConnections} are available. Lower DATABASE_POOL_MAX or add a pooler such as PgBouncer.`;
    if (
      this.config.APP_ENV === 'production' ||
      this.config.APP_ENV === 'staging'
    )
      throw new Error(message);
    this.logger.warn(message);
  }
}
