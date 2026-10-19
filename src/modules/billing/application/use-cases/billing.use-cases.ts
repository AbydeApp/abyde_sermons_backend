import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type {
  PlanAllowance,
  PlanEntitlementsPort,
} from '../../../../shared/application/ports/plan-entitlements.port.js';
import type { SermonQuotaPort } from '../../../sermons/application/ports/out/processing.ports.js';
import {
  USAGE_QUERY,
  type UsageQueryPort,
} from '../../../usage/usage.repository.js';
import {
  type PaidPlanId,
  type PlanFeatures,
  type PlanId,
  PLANS,
  priceLabel,
} from '../../domain/plans.js';
import {
  entitlementFor,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '../../domain/subscription.js';
import {
  BILLING_SETTINGS,
  type BillingEvent,
  type BillingSettings,
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
  SUBSCRIPTION_REPOSITORY,
  type SubscriptionRepositoryPort,
} from '../ports/out/billing.ports.js';

export interface SubscriptionView {
  planId: string;
  planName: string;
  priceLabel: string;
  status: SubscriptionStatus;
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

@Injectable()
export class GetSubscriptionUseCase {
  constructor(
    @Inject(EntitlementService)
    private readonly entitlements: EntitlementService,
  ) {}

  async execute(churchId: string): Promise<SubscriptionView> {
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
}

@Injectable()
export class GetUsageUseCase {
  constructor(
    @Inject(EntitlementService)
    private readonly entitlements: EntitlementService,
  ) {}

  execute(churchId: string): Promise<UsageView> {
    return this.entitlements.usageView(churchId);
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
    const usage = await this.entitlements.usageView(churchId);
    if (usage.sermonsUsed >= usage.sermonsLimit) {
      throw new DomainError(
        'PAYMENT_REQUIRED',
        'PLAN_LIMIT_REACHED',
        `You've used all ${usage.sermonsLimit} sermons in your plan for this period. Upgrade to process more.`,
      );
    }
  }
}

@Injectable()
export class CreateCheckoutUseCase {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProviderPort,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(BILLING_SETTINGS) private readonly settings: BillingSettings,
  ) {}

  async execute(
    churchId: string,
    planId: PaidPlanId,
  ): Promise<{ url: string }> {
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
}

@Injectable()
export class CreatePortalUseCase {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProviderPort,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(CreateCheckoutUseCase)
    private readonly checkout: CreateCheckoutUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** "Upgrade or change plan": the provider's manage link when subscribed, otherwise checkout for Growth. */
  async execute(churchId: string): Promise<{ url: string }> {
    const subscription = await this.subscriptions.findByChurch(churchId);
    const entitlement = entitlementFor(subscription, this.clock.now());
    if (
      subscription?.externalSubscriptionId &&
      entitlement.plan.id !== 'free'
    ) {
      return {
        url: await this.payments.createManageLink(
          subscription.externalSubscriptionId,
        ),
      };
    }
    return this.checkout.execute(churchId, 'growth');
  }
}

export class WebhookRetryLaterError extends Error {}

const MONTH_MS = 31 * 24 * 3600 * 1000;
const RENEWAL_WINDOW_MS = 5 * 24 * 3600 * 1000;

/**
 * Applies verified provider webhooks. Each event id is recorded in the same transaction as its effects,
 * so replays are no-ops and partial failures roll back (the provider then redelivers).
 */
@Injectable()
export class HandleBillingWebhookUseCase {
  private readonly logger = new Logger(HandleBillingWebhookUseCase.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProviderPort,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (
      provider !== this.payments.name ||
      !rawBody ||
      !this.payments.verifySignature(rawBody, headers)
    ) {
      throw new DomainError(
        'UNAUTHENTICATED',
        'INVALID_SIGNATURE',
        'Webhook signature verification failed.',
      );
    }
    const event = this.payments.parseEvent(rawBody);
    await this.uow.run(async () => {
      const fresh = await this.subscriptions.recordWebhookEvent({
        provider,
        eventId: event.eventId,
        type: event.type,
      });
      if (!fresh || event.kind === 'IGNORED') return;
      const churchId = await this.resolveChurch(provider, event);
      if (!churchId) {
        // Unknown customer (events can arrive out of order): fail so the provider retries later.
        throw new WebhookRetryLaterError(
          `Cannot resolve church for ${event.type}`,
        );
      }
      if (event.customerCode)
        await this.subscriptions.linkCustomer({
          churchId,
          provider,
          externalCustomerId: event.customerCode,
        });
      // Events for one church are applied one at a time: Paystack often delivers
      // subscription.create and charge.success together, and each rewrites the subscription row.
      await this.uow.runLocked(`billing:${churchId}`, () =>
        this.apply(churchId, provider, event),
      );
    });
  }

  private async resolveChurch(
    provider: string,
    event: BillingEvent,
  ): Promise<string | null> {
    return (
      event.churchId ??
      (event.subscriptionCode
        ? await this.subscriptions.findChurchBySubscription(
            provider,
            event.subscriptionCode,
          )
        : null) ??
      (event.customerCode
        ? await this.subscriptions.findChurchByCustomer(
            provider,
            event.customerCode,
          )
        : null)
    );
  }

  private paidInFull(event: BillingEvent, planId: PlanId): boolean {
    return (
      event.amountKobo !== null &&
      event.currency === 'NGN' &&
      event.amountKobo >= PLANS[planId].priceKobo
    );
  }

  private async apply(
    churchId: string,
    provider: string,
    event: BillingEvent,
  ): Promise<void> {
    const now = this.clock.now();
    const existing = await this.subscriptions.findByChurch(churchId);
    const base: SubscriptionRecord = existing ?? {
      id: newId(),
      churchId,
      provider,
      planId: event.planId ?? 'growth',
      status: 'ACTIVE',
      externalSubscriptionId: null,
      externalEmailToken: null,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + MONTH_MS),
    };
    let next: SubscriptionRecord = { ...base };
    switch (event.kind) {
      case 'PAYMENT_SUCCEEDED':
      case 'SUBSCRIPTION_CREATED': {
        if (!event.planId && !existing) return; // a one-off charge unrelated to a plan
        const planId = event.planId ?? next.planId;
        if (
          event.kind === 'PAYMENT_SUCCEEDED' &&
          !this.paidInFull(event, planId)
        ) {
          // Never grant a plan for a charge that does not cover it (wrong amount or currency).
          this.logger.warn(
            {
              churchId,
              event: event.type,
              planId,
              amountKobo: event.amountKobo,
              currency: event.currency,
            },
            'Ignoring payment that does not match the plan price',
          );
          return;
        }
        // A charge well inside the current period (e.g. a plan change) keeps the period start;
        // a renewal charge, which arrives around the period end, starts a new usage period.
        const midPeriod =
          existing !== null &&
          existing.status !== 'CANCELLED' &&
          now.getTime() <
            existing.currentPeriodEnd.getTime() - RENEWAL_WINDOW_MS;
        next = {
          ...next,
          planId,
          status: 'ACTIVE',
          externalSubscriptionId:
            event.subscriptionCode ?? next.externalSubscriptionId,
          externalEmailToken: event.emailToken ?? next.externalEmailToken,
          currentPeriodStart:
            event.kind === 'PAYMENT_SUCCEEDED' && !midPeriod
              ? now
              : next.currentPeriodStart,
          currentPeriodEnd:
            event.nextPaymentDate ??
            (event.kind === 'PAYMENT_SUCCEEDED'
              ? new Date(now.getTime() + MONTH_MS)
              : next.currentPeriodEnd),
        };
        break;
      }
      case 'SUBSCRIPTION_NOT_RENEWING':
        if (!existing) return;
        next.status = 'NON_RENEWING';
        break;
      case 'SUBSCRIPTION_DISABLED':
        if (!existing) return;
        next.status = 'CANCELLED';
        break;
      case 'PAYMENT_FAILED':
        if (!existing) return;
        next.status = 'PAST_DUE';
        break;
      default:
        return;
    }
    await this.subscriptions.upsert(next);
    const entitlement = entitlementFor(next, now);
    await this.subscriptions.upsertAllowance({
      churchId,
      planId: entitlement.plan.id,
      sermonsLimit: entitlement.plan.sermonsPerPeriod,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    });
    this.logger.log(
      { churchId, event: event.type, planId: next.planId, status: next.status },
      'Subscription updated from webhook',
    );
  }
}
