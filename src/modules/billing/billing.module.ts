import { Global, Module } from '@nestjs/common';
import { PLAN_ENTITLEMENTS } from '../../shared/application/ports/plan-entitlements.port.js';
import { SERMON_QUOTA } from '../sermons/adapters/ports.js';
import {
  BillingService,
  EntitlementService,
  SermonQuotaService,
} from './billing.service.js';
import { BillingWebhookService } from './webhook.service.js';
import { BillingController } from './billing.controller.js';

/**
 * Global so other modules can enforce plan limits (SERMON_QUOTA, PLAN_ENTITLEMENTS) without
 * importing billing.
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    EntitlementService,
    BillingWebhookService,
    { provide: SERMON_QUOTA, useClass: SermonQuotaService },
    { provide: PLAN_ENTITLEMENTS, useExisting: EntitlementService },
  ],
  exports: [SERMON_QUOTA, PLAN_ENTITLEMENTS],
})
export class BillingModule {}
