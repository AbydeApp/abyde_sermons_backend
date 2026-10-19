# Billing

The current billing contract supersedes the older multi-plan descriptions in SPEC.md.

- One plan: `standard` / Standard, NGN 7,000 (700,000 kobo) per month.
- 15 sermons per billing period, including the trial. Original uploads are retained for 14 days; transcripts and generated content are retained separately.
- One card-free calendar month from church creation. End-of-month dates clamp to the last day of the next month. Reading billing never resets the trial.
- During the trial the API returns `TRIALING`; afterwards it returns `EXPIRED` until payment. New sermon creation requires an active trial/subscription. Existing content remains readable.
- Checkout and the portal fallback return `409 TRIAL_ACTIVE` during the free month, preventing an immediate charge. At expiry, the customer completes hosted checkout to begin recurring payments. There is no automatic charge without subscribing.
- Paid subscriptions retain access through their paid period when non-renewing. Failed renewals retain the existing three-day grace period; cancelled subscriptions have no new-sermon access.

## HTTP contract

All authenticated requests derive the church from the current user.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/billing/subscription` | `planId`, `planName`, `priceLabel`, `status`, `currentPeriodEnd`, `features` |
| `GET /api/v1/billing/usage` | `sermonsUsed`, `sermonsLimit`, `contentGenerated`, `periodEnd` |
| `POST /api/v1/billing/checkout` | Optional `planId: "standard"`; returns hosted checkout URL |
| `POST /api/v1/billing/portal` | Manage an existing provider subscription, otherwise start Standard checkout |
| `POST /api/v1/webhooks/billing/:provider` | Provider-signed lifecycle events, with transactional replay protection |

Checkout and portal require `Idempotency-Key`. Browser redirects never activate a subscription; signed provider events drive subscription state.

The dashboard already has matching subscription/usage service shapes. Its trial button can display the API's `TRIAL_ACTIVE` message. Before connecting live billing, update the UI to distinguish `EXPIRED`, `CANCELLED`, `PAST_DUE`, and `NON_RENEWING` from an upcoming renewal.

## Paystack setup

Create one NGN plan priced at 700,000 kobo with interval `monthly`, and set `BILLING_PAYSTACK_PLAN_STANDARD` along with the existing Paystack secret/provider settings. The adapter checks the configured plan's amount, currency, and interval before initializing checkout: Paystack's plan code overrides the transaction amount ([Paystack subscriptions](https://paystack.com/docs/payments/subscriptions/)).

The old STARTER/GROWTH/MINISTRY environment variables are no longer used. Existing stored subscription records retain their status and dates and are read as Standard; this code does not change existing prices or subscriptions in Paystack. Any previously created provider subscriptions need a deliberate provider-side transition before launch.

## Structure

`billing.controller.ts` handles HTTP, `billing.service.ts` owns billing and entitlements, `webhook.service.ts` handles provider notifications, `billing.repository.ts` colocates the persistence contract and Prisma implementation, `helper.ts` contains plan/date/access rules, and `adapters/` contains provider contracts and implementations. Persistence and payment providers remain bound in the composition modules.
