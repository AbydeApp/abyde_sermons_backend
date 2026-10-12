import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import {
  pageQuery,
  pageRequest,
  toPaginated,
} from '../../../../shared/infrastructure/http/pagination.js';
import { AI_THROTTLE } from '../../../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import {
  CONTENT_STATUSES,
  CONTENT_TYPES,
  REWRITE_ACTIONS,
} from '../../domain/content-types.js';
import {
  ApproveContentUseCase,
  DeleteContentUseCase,
  GetContentUseCase,
  ListContentUseCase,
  ListContentVersionsUseCase,
  RegenerateContentUseCase,
  RestoreContentVersionUseCase,
  RewriteContentUseCase,
  UpdateContentUseCase,
} from '../../application/use-cases/content.use-cases.js';
import { toContentResponse, toVersionResponse } from './content.responses.js';

const ListQuery = z.object({
  status: z.enum(CONTENT_STATUSES, { error: 'Unknown status' }).optional(),
  type: z.enum(CONTENT_TYPES, { error: 'Unknown content type' }).optional(),
  sermonId: z.string().uuid('Invalid sermon id').optional(),
  q: z.string().trim().max(200).optional(),
  scheduled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  ...pageQuery,
});

const PatchBody = z
  .object({
    title: z.string().max(200),
    body: z.string().max(20_000),
    scripture: z.string().max(80).nullable(),
  })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to change',
  );

const RewriteBody = z.object({
  action: z.enum(REWRITE_ACTIONS, { error: 'Unknown rewrite action' }),
});

@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(
    @Inject(ListContentUseCase)
    private readonly listContent: ListContentUseCase,
    @Inject(GetContentUseCase) private readonly getContent: GetContentUseCase,
    @Inject(UpdateContentUseCase)
    private readonly updateContent: UpdateContentUseCase,
    @Inject(ApproveContentUseCase)
    private readonly approveContent: ApproveContentUseCase,
    @Inject(RewriteContentUseCase)
    private readonly rewriteContent: RewriteContentUseCase,
    @Inject(RegenerateContentUseCase)
    private readonly regenerateContent: RegenerateContentUseCase,
    @Inject(DeleteContentUseCase)
    private readonly deleteContent: DeleteContentUseCase,
    @Inject(ListContentVersionsUseCase)
    private readonly listVersions: ListContentVersionsUseCase,
    @Inject(RestoreContentVersionUseCase)
    private readonly restoreVersion: RestoreContentVersionUseCase,
  ) {}

  @Get()
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    const { page, pageSize, q, ...filter } = query;
    return toPaginated(
      await this.listContent.execute(
        churchId,
        { ...filter, q: q || undefined },
        pageRequest({ page, pageSize }),
      ),
      toContentResponse,
    );
  }

  @Get(':id')
  async get(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
  ) {
    return toContentResponse(await this.getContent.execute(churchId, id));
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Body(zod(PatchBody)) body: z.infer<typeof PatchBody>,
  ) {
    return toContentResponse(
      await this.updateContent.execute(churchId, id, body),
    );
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
  ) {
    return toContentResponse(await this.approveContent.execute(churchId, id));
  }

  @Throttle(AI_THROTTLE)
  @Post(':id/rewrite')
  @HttpCode(200)
  async rewrite(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Body(zod(RewriteBody)) body: z.infer<typeof RewriteBody>,
  ) {
    return toContentResponse(
      await this.rewriteContent.execute(churchId, id, body.action),
    );
  }

  @Throttle(AI_THROTTLE)
  @Post(':id/regenerate')
  @HttpCode(200)
  async regenerate(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
  ) {
    return toContentResponse(
      await this.regenerateContent.execute(churchId, id),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
  ): Promise<void> {
    await this.deleteContent.execute(churchId, id);
  }

  @Get(':id/versions')
  async versions(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
  ) {
    return (await this.listVersions.execute(churchId, id)).map(
      toVersionResponse,
    );
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(200)
  async restore(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return toContentResponse(
      await this.restoreVersion.execute(churchId, id, version),
    );
  }
}
