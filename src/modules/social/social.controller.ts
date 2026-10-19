import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../shared/application/auth-context.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { CurrentChurchId, Public, RequiredAuth } from '../../shared/infrastructure/http/auth.decorators.js';
import { RequireIdempotencyKey } from '../../shared/infrastructure/http/idempotency.interceptor.js';
import { pageQuery, pageRequest, toPaginated } from '../../shared/infrastructure/http/pagination.js';
import { CREDENTIAL_THROTTLE } from '../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { ConnectionsService } from './connections.service.js';
import {
  type Actor, isSocialProvider, SOCIAL_PLATFORMS, SOCIAL_POST_STATUSES, type SocialProviderId, toCapabilitiesView,
  toConnectionView, toPostView,
} from './helper.js';
import { PostsService } from './posts.service.js';

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

const CompleteBody = z.strictObject({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
});

const SelectionBody = z.strictObject({
  accountRefs: z
    .array(z.string().max(10))
    .min(1, 'Choose at least one account')
    .max(100),
});

const uuid = z.string().uuid('Invalid id');

/** Settings are validated per platform in the domain; here only their size is bounded. */
const Settings = z
  .record(
    z.string().max(40),
    z.union([
      z.string().max(100),
      z.boolean(),
      z.array(z.string().max(100)).max(30),
    ]),
  )
  .refine((value) => Object.keys(value).length <= 10, 'Too many settings');

const PostBody = z.strictObject({
  // Optional: posts made from a Reel carry its media and no generated content item.
  contentId: uuid.optional(),
  caption: z.string().max(63_206),
  title: z.string().max(200).optional(),
  mediaAssetIds: z.array(uuid).max(35, 'At most 35 media items').default([]),
  thumbnailAssetId: uuid.optional(),
  targets: z
    .array(
      z.strictObject({
        platform: z.enum(SOCIAL_PLATFORMS, { error: 'Unknown platform' }),
        connectionId: uuid,
        settings: Settings.optional(),
      }),
    )
    .max(20, 'At most 20 accounts per post'),
});

const ListQuery = z.strictObject({
  status: z
    .enum(
      SOCIAL_POST_STATUSES.filter((status) => status !== 'rendering') as [
        string,
        ...string[],
      ],
    )
    .optional(),
  contentId: uuid.optional(),
  ...pageQuery,
});

const ScheduleBody = z.strictObject({
  scheduledAt: z.iso
    .datetime({ offset: true, error: 'Use an ISO 8601 date-time' })
    .transform((value) => new Date(value)),
  timezone: z.string().max(64).optional(),
});

const RetryBody = z.strictObject({
  publicationIds: z.array(uuid).max(20).optional(),
  confirmNotPublished: z.boolean().default(false),
});

const actorOf = (auth: AuthContext, churchId: string): Actor => ({ churchId, userId: auth.userId });

/**
 * Connecting accounts. Every route needs a signed-in user (the global guard) except the provider
 * redirect, which only forwards to the web app; completing a connection needs the church and user
 * that started the flow.
 */
@ApiTags('social')
@Controller('social')
export class SocialConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @Get('connections')
  async list(@CurrentChurchId() churchId: string) {
    return (await this.connections.list(churchId)).map(toConnectionView);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Get('connections/:provider/authorize')
  authorize(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
    @Query(zod(AuthorizeQuery)) query: z.infer<typeof AuthorizeQuery>,
  ) {
    return this.connections.startAuthorization(actorOf(auth, churchId), providerFrom(provider), {
      platforms: query.platforms,
    });
  }

  /**
   * Provider redirect target. A browser redirect carries no access token, so this only forwards the
   * result to the web app, which completes the connection with its own sign-in.
   */
  @Public()
  @Get('oauth/:provider/callback')
  callback(
    @Param('provider') provider: string,
    @Query(zod(CallbackQuery)) query: z.infer<typeof CallbackQuery>,
    @Res() res: Response,
  ) {
    res.redirect(302, this.connections.forwardUrl(providerFrom(provider), query));
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Post('oauth/:provider/complete')
  @HttpCode(200)
  complete(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('provider') provider: string,
    @Body(zod(CompleteBody)) body: z.infer<typeof CompleteBody>,
  ) {
    return this.connections.completeAuthorization(providerFrom(provider), body, actorOf(auth, churchId));
  }

  @Get('connections/selections/:selectionId')
  selectionAccounts(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('selectionId', new ParseIdPipe('Account selection')) selectionId: string,
  ) {
    return this.connections.selectionAccounts(actorOf(auth, churchId), selectionId);
  }

  @Post('connections/selections/:selectionId')
  @HttpCode(201)
  async confirmSelection(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('selectionId', new ParseIdPipe('Account selection')) selectionId: string,
    @Body(zod(SelectionBody)) body: z.infer<typeof SelectionBody>,
  ) {
    return (await this.connections.confirmSelection(actorOf(auth, churchId), selectionId, body.accountRefs)).map(
      toConnectionView,
    );
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Post('connections/:connectionId/reconnect')
  @HttpCode(200)
  reconnect(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ) {
    return this.connections.reconnect(actorOf(auth, churchId), connectionId);
  }

  @Delete('connections/:connectionId')
  @HttpCode(204)
  async remove(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ): Promise<void> {
    await this.connections.disconnect(actorOf(auth, churchId), connectionId);
  }

  @Get('connections/:connectionId/capabilities')
  connectionCapabilities(
    @CurrentChurchId() churchId: string,
    @Param('connectionId', new ParseIdPipe('Connection')) connectionId: string,
  ) {
    return this.connections.accountCapabilities(churchId, connectionId);
  }

  @Get('capabilities')
  async platformCapabilities(@CurrentChurchId() _churchId: string) {
    return toCapabilitiesView(await this.connections.platformCapabilities());
  }
}

@ApiTags('social')
@Controller('social/posts')
export class SocialPostsController {
  constructor(@Inject(PostsService) private readonly posts: PostsService) {}

  @Post()
  async create(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Body(zod(PostBody)) body: z.infer<typeof PostBody>,
  ) {
    const result = await this.posts.create(actorOf(auth, churchId), body);
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Get()
  async list(@CurrentChurchId() churchId: string, @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>) {
    const { page, pageSize, status, contentId } = query;
    return toPaginated(
      await this.posts.list(churchId, { status: status as never, contentId }, pageRequest({ page, pageSize })),
      (aggregate) => toPostView(aggregate),
    );
  }

  @Get(':id')
  async get(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Post')) id: string) {
    const result = await this.posts.get(churchId, id);
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Put(':id')
  async update(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
    @Body(zod(PostBody)) body: z.infer<typeof PostBody>,
  ) {
    const result = await this.posts.update(actorOf(auth, churchId), id, body);
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
  ): Promise<void> {
    await this.posts.remove(actorOf(auth, churchId), id);
  }

  /** Sends to every target; must never run twice, so an Idempotency-Key is required. */
  @RequireIdempotencyKey()
  @Post(':id/publish')
  @HttpCode(202)
  async publish(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
  ) {
    return toPostView(await this.posts.publish(actorOf(auth, churchId), id));
  }

  @Post(':id/schedule')
  @HttpCode(200)
  async schedule(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
    @Body(zod(ScheduleBody)) body: z.infer<typeof ScheduleBody>,
  ) {
    return toPostView(await this.posts.schedule(actorOf(auth, churchId), id, body));
  }

  @RequireIdempotencyKey()
  @Post(':id/retry')
  @HttpCode(202)
  async retry(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
    @Body(zod(RetryBody)) body: z.infer<typeof RetryBody>,
  ) {
    return toPostView(await this.posts.retry(actorOf(auth, churchId), id, body));
  }
}
