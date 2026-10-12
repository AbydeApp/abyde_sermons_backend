import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { notFound } from '../../../../shared/domain/domain-error.js';
import type { AuthContext } from '../../../../shared/application/auth-context.js';
import {
  CurrentAuth,
  CurrentChurchId,
  OptionalAuth,
} from '../../../../shared/infrastructure/http/auth.decorators.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import {
  type IntegrationProvider,
  isIntegrationProvider,
} from '../../domain/integration.js';
import {
  CompleteOAuthUseCase,
  ConnectIntegrationUseCase,
  DisconnectIntegrationUseCase,
  ListIntegrationsUseCase,
} from '../../application/use-cases/integration.use-cases.js';

const providerFrom = (raw: string): IntegrationProvider => {
  const provider = raw.toUpperCase();
  if (!isIntegrationProvider(provider)) throw notFound('Integration');
  return provider;
};

const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(ListIntegrationsUseCase)
    private readonly listIntegrations: ListIntegrationsUseCase,
    @Inject(ConnectIntegrationUseCase)
    private readonly connect: ConnectIntegrationUseCase,
    @Inject(CompleteOAuthUseCase)
    private readonly complete: CompleteOAuthUseCase,
    @Inject(DisconnectIntegrationUseCase)
    private readonly disconnect: DisconnectIntegrationUseCase,
  ) {}

  @Get()
  list(@CurrentChurchId() churchId: string) {
    return this.listIntegrations.execute(churchId);
  }

  @Post(':provider/connect')
  @HttpCode(200)
  start(
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
  ) {
    return this.connect.execute(churchId, providerFrom(provider));
  }

  /**
   * Provider redirect target (top-level navigation, so the SameSite=Lax session cookie is sent).
   * Requires both the single-use OAuth state and a session for the church that started the flow.
   */
  @OptionalAuth()
  @Get(':provider/callback')
  async callback(
    @CurrentAuth() auth: AuthContext | null,
    @Param('provider') provider: string,
    @Query(zod(CallbackQuery)) query: z.infer<typeof CallbackQuery>,
    @Res() res: Response,
  ) {
    res.redirect(
      302,
      await this.complete.execute(
        providerFrom(provider),
        query,
        auth?.churchId ?? null,
      ),
    );
  }

  @Delete(':provider')
  @HttpCode(204)
  async remove(
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    await this.disconnect.execute(churchId, providerFrom(provider));
  }
}
