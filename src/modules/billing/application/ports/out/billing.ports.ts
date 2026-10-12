import type { PaidPlanId } from '../../../domain/plans.js';
import type { SubscriptionRecord } from '../../../domain/subscription.js';

export const SUBSCRIPTION_REPOSITORY = Symbol('SUBSCRIPTION_REPOSITORY');

export interface SubscriptionRepositoryPort {
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

export type BillingEventKind =
  | 'PAYMENT_SUCCEEDED'
  | 'SUBSCRIPTION_CREATED'
  | 'SUBSCRIPTION_NOT_RENEWING'
  | 'SUBSCRIPTION_DISABLED'
  | 'PAYMENT_FAILED'
  | 'IGNORED';

/** Provider-neutral billing event parsed from a verified webhook. */
export interface BillingEvent {
  eventId: string;
  type: string;
  kind: BillingEventKind;
  churchId: string | null;
  customerCode: string | null;
  customerEmail: string | null;
  planId: PaidPlanId | null;
  subscriptionCode: string | null;
  emailToken: string | null;
  nextPaymentDate: Date | null;
  /** Amount actually charged, in kobo, and its currency (payment events only). */
  amountKobo: number | null;
  currency: string | null;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface PaymentProviderPort {
  readonly name: string;
  createCheckout(input: {
    churchId: string;
    email: string;
    planId: PaidPlanId;
    amountKobo: number;
    callbackUrl: string;
  }): Promise<{ url: string }>;
  createManageLink(subscriptionCode: string): Promise<string>;
  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean;
  parseEvent(rawBody: Buffer): BillingEvent;
}

export const BILLING_SETTINGS = Symbol('BILLING_SETTINGS');

export interface BillingSettings {
  webUrl: string;
}
