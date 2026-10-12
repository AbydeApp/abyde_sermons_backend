import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';

export type DbClient = Prisma.TransactionClient;

/**
 * Owns the Prisma client. Repositories read `db`, which resolves to the active transaction when
 * called inside UnitOfWork.run(), so use cases compose repositories atomically without passing tx around.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;
  private readonly transactionStore = new AsyncLocalStorage<DbClient>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const adapter = new PrismaPg({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      // Server-side limits: no statement or idle transaction can hold a connection indefinitely.
      statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout:
        config.DATABASE_STATEMENT_TIMEOUT_MS * 2,
    });
    this.client = new PrismaClient({ adapter });
  }

  get db(): DbClient {
    return this.transactionStore.getStore() ?? this.client;
  }

  get inTransaction(): boolean {
    return this.transactionStore.getStore() !== undefined;
  }

  runInTransaction<T>(tx: DbClient, fn: () => Promise<T>): Promise<T> {
    return this.transactionStore.run(tx, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

export const isRecordNotFound = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2025';
