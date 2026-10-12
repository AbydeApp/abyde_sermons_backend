import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthContext } from '../../../../shared/application/auth-context.js';
import {
  CurrentChurchId,
  RequiredAuth,
} from '../../../../shared/infrastructure/http/auth.decorators.js';
import { RequireIdempotencyKey } from '../../../../shared/infrastructure/http/idempotency.interceptor.js';
import {
  pageQuery,
  pageRequest,
  toPaginated,
} from '../../../../shared/infrastructure/http/pagination.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import { SOCIAL_PLATFORMS } from '../../domain/social-platform.js';
import { SOCIAL_POST_STATUSES } from '../../domain/social-post.js';
import { toPostView } from '../../application/social-presenter.js';
import type { Actor } from '../../application/use-cases/connection.use-cases.js';
import {
  CreateSocialPostUseCase,
  DeleteSocialPostUseCase,
  GetSocialPostUseCase,
  ListSocialPostsUseCase,
  PublishSocialPostUseCase,
  RetrySocialPostUseCase,
  ScheduleSocialPostUseCase,
  UpdateSocialPostUseCase,
} from '../../application/use-cases/post.use-cases.js';

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

const actorOf = (auth: AuthContext, churchId: string): Actor => ({
  churchId,
  userId: auth.userId,
});

@ApiTags('social')
@Controller('social/posts')
export class SocialPostsController {
  constructor(
    @Inject(CreateSocialPostUseCase)
    private readonly createPost: CreateSocialPostUseCase,
    @Inject(ListSocialPostsUseCase)
    private readonly listPosts: ListSocialPostsUseCase,
    @Inject(GetSocialPostUseCase)
    private readonly getPost: GetSocialPostUseCase,
    @Inject(UpdateSocialPostUseCase)
    private readonly updatePost: UpdateSocialPostUseCase,
    @Inject(DeleteSocialPostUseCase)
    private readonly deletePost: DeleteSocialPostUseCase,
    @Inject(PublishSocialPostUseCase)
    private readonly publishPost: PublishSocialPostUseCase,
    @Inject(ScheduleSocialPostUseCase)
    private readonly schedulePost: ScheduleSocialPostUseCase,
    @Inject(RetrySocialPostUseCase)
    private readonly retryPost: RetrySocialPostUseCase,
  ) {}

  @Post()
  async create(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Body(zod(PostBody)) body: z.infer<typeof PostBody>,
  ) {
    const result = await this.createPost.execute(actorOf(auth, churchId), body);
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Get()
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    const { page, pageSize, status, contentId } = query;
    return toPaginated(
      await this.listPosts.execute(
        churchId,
        { status: status as never, contentId },
        pageRequest({ page, pageSize }),
      ),
      (aggregate) => toPostView(aggregate),
    );
  }

  @Get(':id')
  async get(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
  ) {
    const result = await this.getPost.execute(churchId, id);
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Put(':id')
  async update(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
    @Body(zod(PostBody)) body: z.infer<typeof PostBody>,
  ) {
    const result = await this.updatePost.execute(
      actorOf(auth, churchId),
      id,
      body,
    );
    return toPostView(result.aggregate, result.mediaPending);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
  ): Promise<void> {
    await this.deletePost.execute(actorOf(auth, churchId), id);
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
    return toPostView(
      await this.publishPost.execute(actorOf(auth, churchId), id),
    );
  }

  @Post(':id/schedule')
  @HttpCode(200)
  async schedule(
    @RequiredAuth() auth: AuthContext,
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Post')) id: string,
    @Body(zod(ScheduleBody)) body: z.infer<typeof ScheduleBody>,
  ) {
    return toPostView(
      await this.schedulePost.execute(actorOf(auth, churchId), id, body),
    );
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
    return toPostView(
      await this.retryPost.execute(actorOf(auth, churchId), id, body),
    );
  }
}
