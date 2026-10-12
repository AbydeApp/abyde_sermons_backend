import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaidPlanId } from '../../domain/plans.js';
import type {
  BillingEvent,
  BillingEventKind,
  PaymentProviderPort,
} from '../../application/ports/out/billing.ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FAKE_WEBHOOK_SECRET = 'fake-billing-secret';

/** Development/test provider: deterministic URLs and an HMAC-signed webhook format mirroring Paystack. */
export class FakePaymentAdapter implements PaymentProviderPort {
  readonly name = 'fake';

  constructor(private readonly webUrl: string) {}

  async createCheckout(input: {
    churchId: string;
    planId: PaidPlanId;
  }): Promise<{ url: string }> {
    return { url: `${this.webUrl}/billing?mockCheckout=${input.planId}` };
  }

  async createManageLink(subscriptionCode: string): Promise<string> {
    return `${this.webUrl}/billing?mockManage=${encodeURIComponent(subscriptionCode)}`;
  }

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const signature = headers['x-fake-signature'];
    if (typeof signature !== 'string') return false;
    const expected = Buffer.from(FakePaymentAdapter.sign(rawBody), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  parseEvent(rawBody: Buffer): BillingEvent {
    const event = JSON.parse(
      rawBody.toString('utf8'),
    ) as Partial<BillingEvent> & { id: string; type: string };
    return {
      eventId: event.id,
      type: event.type,
      kind: (event.kind as BillingEventKind | undefined) ?? 'IGNORED',
      churchId:
        typeof event.churchId === 'string' && UUID.test(event.churchId)
          ? event.churchId
          : null,
      customerCode: event.customerCode ?? null,
      customerEmail: event.customerEmail ?? null,
      planId: event.planId ?? null,
      subscriptionCode: event.subscriptionCode ?? null,
      emailToken: null,
      nextPaymentDate: event.nextPaymentDate
        ? new Date(event.nextPaymentDate)
        : null,
      amountKobo:
        typeof event.amountKobo === 'number' ? event.amountKobo : null,
      currency: typeof event.currency === 'string' ? event.currency : null,
    };
  }

  static sign(rawBody: Buffer | string): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
  }
}
