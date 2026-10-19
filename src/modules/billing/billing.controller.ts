import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../shared/domain/domain-error.js';
import {
  CurrentChurchId,
  Public,
} from '../../shared/infrastructure/http/auth.decorators.js';
import { RequireIdempotencyKey } from '../../shared/infrastructure/http/idempotency.interceptor.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { PAID_PLAN_IDS } from './helper.js';
import { BillingService } from './billing.service.js';
import {
  BillingWebhookService,
  WebhookRetryLaterError,
} from './webhook.service.js';

const CheckoutBody = z.object({
  planId: z.enum(PAID_PLAN_IDS, { error: 'Unknown plan' }).default('standard'),
});

@ApiTags('billing')
@Controller()
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingWebhookService)
    private readonly handleWebhook: BillingWebhookService,
  ) {}

  @Get('billing/subscription')
  async subscription(@CurrentChurchId() churchId: string) {
    const view = await this.billing.subscription(churchId);
    return { ...view, currentPeriodEnd: view.currentPeriodEnd.toISOString() };
  }

  @Get('billing/usage')
  async usage(@CurrentChurchId() churchId: string) {
    const view = await this.billing.usage(churchId);
    return { ...view, periodEnd: view.periodEnd.toISOString() };
  }

  @RequireIdempotencyKey()
  @Post('billing/checkout')
  @HttpCode(200)
  checkout(
    @CurrentChurchId() churchId: string,
    @Body(zod(CheckoutBody)) body: z.infer<typeof CheckoutBody>,
  ) {
    return this.billing.checkout(churchId, body.planId);
  }

  @RequireIdempotencyKey()
  @Post('billing/portal')
  @HttpCode(200)
  portal(@CurrentChurchId() churchId: string) {
    return this.billing.portal(churchId);
  }

  /** Server-to-server: authenticated by provider signature over the raw body, never by session. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/billing/:provider')
  @HttpCode(200)
  async webhook(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      await this.handleWebhook.execute(provider, req.rawBody, headers);
      return { received: true };
    } catch (error) {
      if (error instanceof WebhookRetryLaterError) {
        throw new DomainError(
          'UNAVAILABLE',
          'RETRY_LATER',
          'Event cannot be processed yet.',
        );
      }
      throw error;
    }
  }
}
