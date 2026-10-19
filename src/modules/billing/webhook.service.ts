import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../shared/application/ports/unit-of-work.port.js';
import { DomainError } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import {
  entitlementFor,
  nextMonth,
  PLANS,
  type PlanId,
  type SubscriptionRecord,
} from './helper.js';
import {
  PAYMENT_PROVIDER,
  type BillingEvent,
  type PaymentProviderPort,
} from './adapters/ports.js';
import {
  SUBSCRIPTION_REPOSITORY,
  type SubscriptionRepositoryPort,
} from './billing.repository.js';

export class WebhookRetryLaterError extends Error {}

const RENEWAL_WINDOW_MS = 5 * 24 * 3600 * 1000;

/**
 * Applies verified provider webhooks. Each event id is recorded in the same transaction as its effects,
 * so replays are no-ops and partial failures roll back (the provider then redelivers).
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

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
      planId: event.planId ?? 'standard',
      status: 'ACTIVE',
      externalSubscriptionId: null,
      externalEmailToken: null,
      currentPeriodStart: now,
      currentPeriodEnd: nextMonth(now),
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
              ? nextMonth(now)
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
      sermonsLimit: entitlement.active ? entitlement.plan.sermonsPerPeriod : 0,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    });
    this.logger.log(
      { churchId, event: event.type, planId: next.planId, status: next.status },
      'Subscription updated from webhook',
    );
  }
}
