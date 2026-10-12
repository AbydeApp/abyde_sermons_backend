import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../../../../shared/domain/id.js';
import {
  isUniqueViolation,
  PrismaService,
} from '../../../../shared/infrastructure/prisma/prisma.service.js';
import { isPlanId } from '../../domain/plans.js';
import type { SubscriptionRecord } from '../../domain/subscription.js';
import type { SubscriptionRepositoryPort } from '../../application/ports/out/billing.ports.js';

@Injectable()
export class PrismaSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByChurch(churchId: string): Promise<SubscriptionRecord | null> {
    const row = await this.prisma.db.subscription.findUnique({
      where: { churchId },
    });
    if (!row || !isPlanId(row.planId)) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      provider: row.provider,
      planId: row.planId,
      status: row.status,
      externalSubscriptionId: row.externalSubscriptionId,
      externalEmailToken: row.externalEmailToken,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
    };
  }

  async upsert(subscription: SubscriptionRecord): Promise<void> {
    const { id, churchId, ...data } = subscription;
    await this.prisma.db.subscription.upsert({
      where: { churchId },
      create: { id, churchId, ...data },
      update: data,
    });
  }

  async upsertAllowance(input: {
    churchId: string;
    planId: string;
    sermonsLimit: number;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void> {
    const { churchId, ...data } = input;
    await this.prisma.db.usageAllowance.upsert({
      where: { churchId },
      create: { id: newId(), churchId, ...data },
      update: data,
    });
  }

  async linkCustomer(input: {
    churchId: string;
    provider: string;
    externalCustomerId: string;
  }): Promise<void> {
    await this.prisma.db.billingCustomer.upsert({
      where: { churchId: input.churchId },
      create: { id: newId(), ...input },
      update: {
        provider: input.provider,
        externalCustomerId: input.externalCustomerId,
      },
    });
  }

  async findChurchByCustomer(
    provider: string,
    externalCustomerId: string,
  ): Promise<string | null> {
    const row = await this.prisma.db.billingCustomer.findUnique({
      where: { provider_externalCustomerId: { provider, externalCustomerId } },
      select: { churchId: true },
    });
    return row?.churchId ?? null;
  }

  async findChurchBySubscription(
    provider: string,
    externalSubscriptionId: string,
  ): Promise<string | null> {
    const row = await this.prisma.db.subscription.findFirst({
      where: { provider, externalSubscriptionId },
      select: { churchId: true },
    });
    return row?.churchId ?? null;
  }

  async findOwnerEmail(churchId: string): Promise<string | null> {
    const row = await this.prisma.db.church.findUnique({
      where: { id: churchId },
      select: { user: { select: { email: true } } },
    });
    return row?.user.email ?? null;
  }

  async deleteWebhookEventsBefore(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.webhookEvent.deleteMany({
        where: { receivedAt: { lt: cutoff } },
      })
    ).count;
  }

  async recordWebhookEvent(input: {
    provider: string;
    eventId: string;
    type: string;
  }): Promise<boolean> {
    try {
      await this.prisma.db.webhookEvent.create({
        data: { id: newId(), ...input, processedAt: new Date() },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}
