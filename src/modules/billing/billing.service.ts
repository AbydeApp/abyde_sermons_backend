import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../shared/application/ports/clock.port.js';
import { DomainError } from '../../shared/domain/domain-error.js';
import type {
  PlanAllowance,
  PlanEntitlementsPort,
} from '../../shared/application/ports/plan-entitlements.port.js';
import type { SermonQuotaPort } from '../sermons/adapters/ports.js';
import { USAGE_QUERY, type UsageQueryPort } from '../usage/usage.repository.js';
import {
  type PaidPlanId,
  type PlanFeatures,
  PLANS,
  priceLabel,
} from './helper.js';
import { entitlementFor, type SubscriptionStatus } from './helper.js';
import {
  BILLING_SETTINGS,
  type BillingSettings,
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from './adapters/ports.js';
import {
  SUBSCRIPTION_REPOSITORY,
  type SubscriptionRepositoryPort,
} from './billing.repository.js';

export interface SubscriptionView {
  planId: string;
  planName: string;
  priceLabel: string;
  status: SubscriptionStatus | 'TRIALING' | 'EXPIRED';
  currentPeriodEnd: Date;
  /** Features available on the current plan. */
  features: PlanFeatures;
}

export interface UsageView {
  sermonsUsed: number;
  sermonsLimit: number;
  contentGenerated: number;
  periodEnd: Date;
}

/** The single place plan rules are evaluated; other modules read them through PLAN_ENTITLEMENTS. */
@Injectable()
export class EntitlementService implements PlanEntitlementsPort {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(USAGE_QUERY) private readonly usage: UsageQueryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async current(churchId: string) {
    return entitlementFor(
      await this.subscriptions.findByChurch(churchId),
      this.clock.now(),
      await this.subscriptions.findChurchCreatedAt(churchId),
    );
  }

  async usageView(churchId: string): Promise<UsageView> {
    const entitlement = await this.current(churchId);
    // Sequential on purpose: this can run inside a transaction, which has a single connection.
    const sermonsUsed = await this.usage.total(
      churchId,
      'SERMON_PROCESSED',
      entitlement.periodStart,
      entitlement.periodEnd,
    );
    const contentGenerated = await this.usage.total(
      churchId,
      'CONTENT_GENERATED',
      entitlement.periodStart,
      entitlement.periodEnd,
    );
    return {
      sermonsUsed,
      sermonsLimit: entitlement.plan.sermonsPerPeriod,
      contentGenerated,
      periodEnd: entitlement.periodEnd,
    };
  }

  async allowance(churchId: string): Promise<PlanAllowance> {
    const { plan, periodStart, periodEnd } = await this.current(churchId);
    return {
      planId: plan.id,
      planName: plan.name,
      periodStart,
      periodEnd,
      sourceRetentionDays: plan.sourceRetentionDays,
    };
  }
}

/** Plan enforcement for sermon uploads (runs inside the sermon-creation lock). */
@Injectable()
export class SermonQuotaService implements SermonQuotaPort {
  constructor(
    @Inject(EntitlementService)
    private readonly entitlements: EntitlementService,
  ) {}

  async assertCanCreateSermon(churchId: string): Promise<void> {
    if (!(await this.entitlements.current(churchId)).active) {
      throw new DomainError(
        'PAYMENT_REQUIRED',
        'SUBSCRIPTION_REQUIRED',
        'Your free month or subscription has ended. Subscribe for ₦7,000/month to process sermons.',
      );
    }
    const usage = await this.entitlements.usageView(churchId);
    if (usage.sermonsUsed >= usage.sermonsLimit) {
      throw new DomainError(
        'PAYMENT_REQUIRED',
        'PLAN_LIMIT_REACHED',
        `You've used all ${usage.sermonsLimit} sermons in your plan for this period. Your allowance resets at the start of your next billing period.`,
      );
    }
  }
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(EntitlementService)
    private readonly entitlements: EntitlementService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProviderPort,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(BILLING_SETTINGS) private readonly settings: BillingSettings,
  ) {}

  async subscription(churchId: string): Promise<SubscriptionView> {
    const entitlement = await this.entitlements.current(churchId);
    return {
      planId: entitlement.plan.id,
      planName: entitlement.plan.name,
      priceLabel: priceLabel(entitlement.plan),
      status: entitlement.status,
      currentPeriodEnd: entitlement.periodEnd,
      features: {
        sourceRetentionDays: entitlement.plan.sourceRetentionDays,
      },
    };
  }

  usage(churchId: string): Promise<UsageView> {
    return this.entitlements.usageView(churchId);
  }

  async checkout(
    churchId: string,
    planId: PaidPlanId = 'standard',
  ): Promise<{ url: string }> {
    const current = await this.entitlements.current(churchId);
    if (current.status === 'TRIALING') {
      throw new DomainError(
        'CONFLICT',
        'TRIAL_ACTIVE',
        'Your first month is free. You can subscribe when your trial ends.',
      );
    }
    const email = await this.subscriptions.findOwnerEmail(churchId);
    if (!email)
      throw new DomainError('NOT_FOUND', 'NOT_FOUND', 'Church was not found.');
    return this.payments.createCheckout({
      churchId,
      email,
      planId,
      amountKobo: PLANS[planId].priceKobo,
      callbackUrl: `${this.settings.webUrl}/billing?checkout=complete`,
    });
  }

  async portal(churchId: string): Promise<{ url: string }> {
    const subscription = await this.subscriptions.findByChurch(churchId);
    if (subscription?.externalSubscriptionId) {
      return {
        url: await this.payments.createManageLink(
          subscription.externalSubscriptionId,
        ),
      };
    }
    return this.checkout(churchId);
  }
}
