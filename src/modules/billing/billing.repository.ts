import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../../shared/domain/id.js';
import {
  isUniqueViolation,
  PrismaService,
} from '../../shared/infrastructure/prisma/prisma.service.js';
import type { SubscriptionRecord } from './helper.js';
export const SUBSCRIPTION_REPOSITORY = Symbol('SUBSCRIPTION_REPOSITORY');

export interface SubscriptionRepositoryPort {
  findChurchCreatedAt(churchId: string): Promise<Date | null>;
  findByChurch(churchId: string): Promise<SubscriptionRecord | null>;
  upsert(subscription: SubscriptionRecord): Promise<void>;
  upsertAllowance(input: {
    churchId: string;
    planId: string;
    sermonsLimit: number;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void>;
  linkCustomer(input: {
    churchId: string;
    provider: string;
    externalCustomerId: string;
  }): Promise<void>;
  findChurchByCustomer(
    provider: string,
    externalCustomerId: string,
  ): Promise<string | null>;
  findChurchBySubscription(
    provider: string,
    externalSubscriptionId: string,
  ): Promise<string | null>;
  findOwnerEmail(churchId: string): Promise<string | null>;
  /** Records a webhook delivery; false when this event was already processed (replay). */
  /** Maintenance: removes webhook delivery records received before `cutoff`; returns how many. */
  deleteWebhookEventsBefore(cutoff: Date): Promise<number>;
  recordWebhookEvent(input: {
    provider: string;
    eventId: string;
    type: string;
  }): Promise<boolean>;
}

@Injectable()
export class PrismaSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findChurchCreatedAt(churchId: string): Promise<Date | null> {
    const church = await this.prisma.db.church.findUnique({
      where: { id: churchId },
      select: { createdAt: true },
    });
    return church?.createdAt ?? null;
  }

  async findByChurch(churchId: string): Promise<SubscriptionRecord | null> {
    const row = await this.prisma.db.subscription.findUnique({
      where: { churchId },
    });
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      provider: row.provider,
      planId: 'standard',
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
