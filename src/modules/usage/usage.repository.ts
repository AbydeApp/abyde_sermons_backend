import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  AIUsageEntry,
  AIUsageRecorderPort,
  UsageMeterPort,
  UsageRecord,
  UsageUnit,
} from '../../shared/application/ports/usage-meter.port.js';
import { newId } from '../../shared/domain/id.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';

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

@Injectable()
export class PrismaUsageMeter implements UsageMeterPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(usage: UsageRecord): Promise<void> {
    // ON CONFLICT (dedupe_key) DO NOTHING keeps metering idempotent across retries.
    await this.prisma.db.usageEvent.createMany({
      data: [
        {
          id: newId(),
          churchId: usage.churchId,
          unit: usage.unit,
          quantity: usage.quantity,
          sermonId: usage.sermonId,
          dedupeKey: usage.dedupeKey,
        },
      ],
      skipDuplicates: true,
    });
  }
}

@Injectable()
export class PrismaAIUsageRecorder implements AIUsageRecorderPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(entry: AIUsageEntry): Promise<void> {
    // Written outside any business transaction so a rolled-back operation still leaves its cost trail.
    await this.prisma.client.aIUsageLog.create({
      data: {
        id: newId(),
        ...entry,
        estimatedCost: new Prisma.Decimal(entry.estimatedCost.toFixed(6)),
      },
    });
  }

  async deleteBefore(cutoff: Date): Promise<number> {
    return (
      await this.prisma.client.aIUsageLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      })
    ).count;
  }
}

@Injectable()
export class PrismaUsageQuery implements UsageQueryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async total(
    churchId: string,
    unit: UsageUnit,
    from: Date,
    to: Date,
  ): Promise<number> {
    const result = await this.prisma.db.usageEvent.aggregate({
      where: { churchId, unit, createdAt: { gte: from, lt: to } },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
  }
}
