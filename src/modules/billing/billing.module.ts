import { Global, Module } from '@nestjs/common';
import { PLAN_ENTITLEMENTS } from '../../shared/application/ports/plan-entitlements.port.js';
import { SERMON_QUOTA } from '../sermons/application/ports/out/processing.ports.js';
import {
  CreateCheckoutUseCase,
  CreatePortalUseCase,
  EntitlementService,
  GetSubscriptionUseCase,
  GetUsageUseCase,
  HandleBillingWebhookUseCase,
  SermonQuotaService,
} from './application/use-cases/billing.use-cases.js';
import { BillingController } from './presentation/http/billing.controller.js';

/**
 * Global so other modules can enforce plan limits (SERMON_QUOTA, PLAN_ENTITLEMENTS) without
 * importing billing.
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [
    EntitlementService,
    GetSubscriptionUseCase,
    GetUsageUseCase,
    CreateCheckoutUseCase,
    CreatePortalUseCase,
    HandleBillingWebhookUseCase,
    { provide: SERMON_QUOTA, useClass: SermonQuotaService },
    { provide: PLAN_ENTITLEMENTS, useExisting: EntitlementService },
  ],
  exports: [SERMON_QUOTA, PLAN_ENTITLEMENTS],
})
export class BillingModule {}
