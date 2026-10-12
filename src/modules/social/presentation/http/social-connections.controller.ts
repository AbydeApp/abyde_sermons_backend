import {
  Body,
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
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../../../shared/application/auth-context.js';
import { notFound } from '../../../../shared/domain/domain-error.js';
import {
  CurrentAuth,
  CurrentChurchId,
  OptionalAuth,
  RequiredAuth,
} from '../../../../shared/infrastructure/http/auth.decorators.js';
import { CREDENTIAL_THROTTLE } from '../../../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import {
  isSocialProvider,
  SOCIAL_PLATFORMS,
  type SocialProviderId,
} from '../../domain/social-platform.js';
import {
  toCapabilitiesView,
  toConnectionView,
} from '../../application/social-presenter.js';
import {
  type Actor,
  CompleteSocialAuthorizationUseCase,
  DisconnectSocialConnectionUseCase,
  GetConnectionCapabilitiesUseCase,
  GetSocialCapabilitiesUseCase,
  ListSocialConnectionsUseCase,
  SocialAccountSelectionUseCase,
  StartSocialAuthorizationUseCase,
} from '../../application/use-cases/connection.use-cases.js';

const providerFrom = (raw: string): SocialProviderId => {
  const provider = raw.toLowerCase();
  if (!isSocialProvider(provider)) throw notFound('Provider');
  return provider;
};

const AuthorizeQuery = z.strictObject({
  platforms: z
    .string()
    .max(100)
    .transform((value) =>
      value.split(',').map((entry) => entry.trim().toLowerCase()),
    )
    .pipe(z.array(z.enum(SOCIAL_PLATFORMS, { error: 'Unknown platform' })))
    .optional(),
});

const CallbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

const SelectionBody = z.strictObject({
  accountRefs: z
    .array(z.string().max(10))
    .min(1, 'Choose at least one account')
    .max(100),
});

const actorOf = (auth: AuthContext, churchId: string): Actor => ({
  churchId,
  userId: auth.userId,
});

/**
 * Connecting accounts. Every route needs a session (the global guard); the provider callback is
 * the only optional-auth route, and it connects nothing unless the session matches the church and
 * user that started the flow.
 */
@ApiTags('social')
@Controller('social')
export class SocialConnectionsController {
  constructor(
    @Inject(ListSocialConnectionsUseCase)
    private readonly listConnections: ListSocialConnectionsUseCase,
    @Inject(StartSocialAuthorizationUseCase)
    private readonly start: StartSocialAuthorizationUseCase,
    @Inject(CompleteSocialAuthorizationUseCase)
    private readonly complete: CompleteSocialAuthorizationUseCase,
    @Inject(SocialAccountSelectionUseCase)
    private readonly selection: SocialAccountSelectionUseCase,
    @Inject(DisconnectSocialConnectionUseCase)
    private readonly disconnect: DisconnectSocialConnectionUseCase,
    @Inject(GetSocialCapabilitiesUseCase)
    private readonly capabilities: GetSocialCapabilitiesUseCase,
    @Inject(GetConnectionCapabilitiesUseCase)
    private readonly accountCapabilities: GetConnectionCapabilitiesUseCase,
  ) {}

  @Get('connections')
  async list(@CurrentChurchId() churchId: string) {
    return (await this.listConnections.execute(churchId)).map(toConnectionView);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Get('connections/:provider/authorize')
  authorize(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
    @Query(zod(AuthorizeQuery)) query: z.infer<typeof AuthorizeQuery>,
  ) {
    return this.start.execute(actorOf(auth, churchId), providerFrom(provider), {
      platforms: query.platforms,
    });
  }

  /** Provider redirect target: a top-level navigation, so the SameSite=Lax session cookie is sent. */
  @OptionalAuth()
  @Get('oauth/:provider/callback')
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
        auth?.churchId
          ? { churchId: auth.churchId, userId: auth.userId }
          : null,
      ),
    );
  }

  @Get('connections/selections/:selectionId')
  selectionAccounts(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('selectionId', new ParseIdPipe('Account selection'))
    selectionId: string,
  ) {
    return this.selection.list(actorOf(auth, churchId), selectionId);
  }

  @Post('connections/selections/:selectionId')
  @HttpCode(201)
  async confirmSelection(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('selectionId', new ParseIdPipe('Account selection'))
    selectionId: string,
    @Body(zod(SelectionBody)) body: z.infer<typeof SelectionBody>,
  ) {
    return (
      await this.selection.confirm(
        actorOf(auth, churchId),
        selectionId,
        body.accountRefs,
      )
    ).map(toConnectionView);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Post('connections/:connectionId/reconnect')
  @HttpCode(200)
  async reconnect(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ) {
    const connection = (await this.listConnections.execute(churchId)).find(
      (entry) => entry.id === connectionId,
    );
    if (!connection) throw notFound('Connection');
    return this.start.execute(actorOf(auth, churchId), connection.provider, {
      reconnectConnectionId: connectionId,
    });
  }

  @Delete('connections/:connectionId')
  @HttpCode(204)
  async remove(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ): Promise<void> {
    await this.disconnect.execute(actorOf(auth, churchId), connectionId);
  }

  @Get('connections/:connectionId/capabilities')
  connectionCapabilities(
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ) {
    return this.accountCapabilities.execute(churchId, connectionId);
  }

  @Get('capabilities')
  async platformCapabilities(@CurrentChurchId() _churchId: string) {
    return toCapabilitiesView(await this.capabilities.execute());
  }
}
