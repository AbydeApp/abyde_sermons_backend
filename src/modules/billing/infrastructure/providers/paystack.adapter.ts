import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DependencyGuard } from '../../../../shared/infrastructure/resilience/dependency-guard.js';
import type { PaidPlanId } from '../../domain/plans.js';
import type {
  BillingEvent,
  BillingEventKind,
  PaymentProviderPort,
} from '../../application/ports/out/billing.ports.js';

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackWebhook {
  event: string;
  data: {
    id?: number;
    amount?: number;
    currency?: string;
    reference?: string;
    subscription_code?: string;
    email_token?: string;
    next_payment_date?: string | null;
    plan?: { plan_code?: string } | null;
    customer?: { customer_code?: string; email?: string };
    metadata?: { churchId?: string } | string | null;
    subscription?: {
      subscription_code?: string;
      next_payment_date?: string | null;
    };
  };
}

const EVENT_KINDS: Record<string, BillingEventKind> = {
  'charge.success': 'PAYMENT_SUCCEEDED',
  'subscription.create': 'SUBSCRIPTION_CREATED',
  'subscription.not_renew': 'SUBSCRIPTION_NOT_RENEWING',
  'subscription.disable': 'SUBSCRIPTION_DISABLED',
  'invoice.payment_failed': 'PAYMENT_FAILED',
};

const UUID = /^[0-9a-f-]{36}$/i;

/** Paystack (Nigeria) adapter: hosted checkout, subscription manage links, HMAC-SHA512 webhooks. */
export class PaystackAdapter implements PaymentProviderPort {
  readonly name = 'paystack';
  private readonly guard = new DependencyGuard('paystack', {
    maxConcurrent: 8,
    failureThreshold: 5,
    openMs: 30_000,
  });
  private readonly planIdByCode: Map<string, PaidPlanId>;

  constructor(
    private readonly secretKey: string,
    private readonly planCodes: Partial<Record<PaidPlanId, string>>,
  ) {
    this.planIdByCode = new Map(
      Object.entries(planCodes).flatMap(([id, code]) =>
        code ? [[code, id as PaidPlanId]] : [],
      ),
    );
  }

  async createCheckout(input: {
    churchId: string;
    email: string;
    planId: PaidPlanId;
    amountKobo: number;
    callbackUrl: string;
  }): Promise<{ url: string }> {
    const plan = this.planCodes[input.planId];
    if (!plan)
      throw new Error(`No Paystack plan configured for ${input.planId}`);
    const response = await this.request<{ authorization_url: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          amount: input.amountKobo,
          currency: 'NGN',
          plan,
          callback_url: input.callbackUrl,
          metadata: { churchId: input.churchId, planId: input.planId },
        }),
      },
    );
    return { url: response.authorization_url };
  }

  async createManageLink(subscriptionCode: string): Promise<string> {
    const response = await this.request<{ link: string }>(
      `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`,
      { method: 'GET' },
    );
    return response.link;
  }

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const signature = headers['x-paystack-signature'];
    if (typeof signature !== 'string') return false;
    const expected = createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseEvent(rawBody: Buffer): BillingEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as PaystackWebhook;
    const data = payload.data ?? {};
    const metadata =
      typeof data.metadata === 'object' && data.metadata !== null
        ? data.metadata
        : {};
    const planCode = data.plan?.plan_code;
    const nextPayment =
      data.next_payment_date ?? data.subscription?.next_payment_date ?? null;
    return {
      // Paystack has no event id; the body hash identifies a delivery and makes replays idempotent.
      eventId: `${payload.event}:${data.id ?? data.reference ?? data.subscription_code ?? ''}:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`,
      type: payload.event,
      kind: EVENT_KINDS[payload.event] ?? 'IGNORED',
      churchId:
        typeof metadata.churchId === 'string' && UUID.test(metadata.churchId)
          ? metadata.churchId
          : null,
      customerCode: data.customer?.customer_code ?? null,
      customerEmail: data.customer?.email ?? null,
      planId: planCode ? (this.planIdByCode.get(planCode) ?? null) : null,
      subscriptionCode:
        data.subscription_code ?? data.subscription?.subscription_code ?? null,
      emailToken: data.email_token ?? null,
      nextPaymentDate: nextPayment ? new Date(nextPayment) : null,
      amountKobo: typeof data.amount === 'number' ? data.amount : null,
      currency: typeof data.currency === 'string' ? data.currency : null,
    };
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const response = await this.guard.run(() =>
      fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      }).then((res) => {
        // A 5xx/429 counts against the provider; the body is still read by the caller.
        if (res.status >= 500 || res.status === 429)
          throw new Error(`Paystack responded ${res.status}`);
        return res;
      }),
    );
    const body = (await response
      .json()
      .catch(() => null)) as PaystackEnvelope<T> | null;
    if (!response.ok || !body?.status)
      throw new Error(
        `Paystack ${path} failed (${response.status}): ${body?.message ?? 'no body'}`,
      );
    return body.data;
  }
}
