import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';
import { PrismaService } from './prisma.service.js';

const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 20_000 } as const;

@Injectable()
export class PrismaUnitOfWork implements UnitOfWorkPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.prisma.inTransaction) return fn(); // nested calls join the outer transaction
    return this.prisma.client.$transaction(
      (tx) => this.prisma.runInTransaction(tx, fn),
      TRANSACTION_OPTIONS,
    );
  }

  runLocked<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      // Transaction-scoped advisory lock, released automatically on commit/rollback.
      await this.prisma.db
        .$executeRaw`SELECT pg_advisory_xact_lock(${advisoryKey(lockKey)})`;
      return fn();
    });
  }
}

/** Maps an arbitrary string to a signed 64-bit advisory lock key. */
function advisoryKey(lockKey: string): bigint {
  return createHash('sha256').update(lockKey).digest().readBigInt64BE(0);
}
