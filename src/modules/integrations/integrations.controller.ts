import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentChurchId, Public } from '../../shared/infrastructure/http/auth.decorators.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { CallbackQuery, CompleteBody, providerFrom } from './helper.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentChurchId() churchId: string) {
    return this.integrations.list(churchId);
  }

  @Post(':provider/connect')
  @HttpCode(200)
  connect(@CurrentChurchId() churchId: string, @Param('provider') provider: string) {
    return this.integrations.connect(churchId, providerFrom(provider));
  }

  /**
   * Provider redirect target. A browser redirect carries no access token, so this only forwards the
   * result to the web app, which completes the connection with its own sign-in.
   */
  @Public()
  @Get(':provider/callback')
  callback(
    @Param('provider') provider: string,
    @Query(zod(CallbackQuery)) query: z.infer<typeof CallbackQuery>,
    @Res() res: Response,
  ) {
    res.redirect(302, this.integrations.callbackRedirect(providerFrom(provider), query));
  }

  @Post(':provider/complete')
  @HttpCode(200)
  complete(
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
    @Body(zod(CompleteBody)) body: z.infer<typeof CompleteBody>,
  ) {
    return this.integrations.complete(churchId, providerFrom(provider), body);
  }

  @Delete(':provider')
  @HttpCode(204)
  async remove(@CurrentChurchId() churchId: string, @Param('provider') provider: string): Promise<void> {
    await this.integrations.disconnect(churchId, providerFrom(provider));
  }
}
