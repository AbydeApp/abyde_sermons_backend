import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  HOOK_STYLES,
} from '../../../brand/domain/video-settings.js';
import { ReelPresenter } from '../../application/reel-presenter.js';
import {
  ListReelCandidatesUseCase,
  RegenerateReelCandidatesUseCase,
} from '../../application/use-cases/reel-candidates.use-cases.js';
import { RequestReelRenderUseCase } from '../../application/use-cases/reel-render.use-cases.js';
import {
  ApproveReelUseCase,
  CreateReelUseCase,
  DeleteReelUseCase,
  GenerateReelHooksUseCase,
  GetReelUseCase,
  ListReelsUseCase,
  UpdateReelUseCase,
} from '../../application/use-cases/reels.use-cases.js';
import { MAX_HOOK_CHARS, REEL_STATUSES } from '../../domain/reel.js';
import { toCandidateResponse, toReelResponse } from './reel.responses.js';

const ms = z
  .number()
  .int()
  .min(0)
  .max(24 * 3600 * 1000);
const title = z.string().max(120);

const CreateBody = z.union([
  z.strictObject({
    candidateId: z.string().uuid('Invalid candidate id'),
    title: title.optional(),
  }),
  z.strictObject({
    sermonId: z.string().uuid('Invalid sermon id'),
    startMs: ms,
    endMs: ms,
    title: title.optional(),
  }),
]);

const HookBody = z.strictObject({
  text: z.string().max(MAX_HOOK_CHARS + 20),
  style: z.enum(HOOK_STYLES, { error: 'Unknown hook style' }),
});

const PatchBody = z
  .strictObject({
    title,
    hook: HookBody.nullable(),
    captionStyle: z.enum(CAPTION_STYLES, { error: 'Unknown caption style' }),
    captionPosition: z.enum(CAPTION_POSITIONS, {
      error: 'Unknown caption position',
    }),
    startMs: ms,
    endMs: ms,
  })
  .partial();

const ListQuery = z.object({
  sermonId: z.string().uuid('Invalid sermon id').optional(),
  status: z.enum(REEL_STATUSES, { error: 'Unknown status' }).optional(),
  ...pageQuery,
});

@ApiTags('reels')
@Controller()
export class ReelsController {
  constructor(
    @Inject(ListReelCandidatesUseCase)
    private readonly listCandidates: ListReelCandidatesUseCase,
    @Inject(RegenerateReelCandidatesUseCase)
    private readonly regenerateCandidates: RegenerateReelCandidatesUseCase,
    @Inject(CreateReelUseCase) private readonly createReel: CreateReelUseCase,
    @Inject(ListReelsUseCase) private readonly listReels: ListReelsUseCase,
    @Inject(GetReelUseCase) private readonly getReel: GetReelUseCase,
    @Inject(UpdateReelUseCase) private readonly updateReel: UpdateReelUseCase,
    @Inject(GenerateReelHooksUseCase)
    private readonly generateHooks: GenerateReelHooksUseCase,
    @Inject(RequestReelRenderUseCase)
    private readonly requestRender: RequestReelRenderUseCase,
    @Inject(ApproveReelUseCase)
    private readonly approveReel: ApproveReelUseCase,
    @Inject(DeleteReelUseCase) private readonly deleteReel: DeleteReelUseCase,
    @Inject(ReelPresenter) private readonly presenter: ReelPresenter,
  ) {}

  @Get('sermons/:sermonId/reel-candidates')
  async candidates(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', ParseIdPipe) sermonId: string,
  ) {
    const list = await this.listCandidates.execute(churchId, sermonId);
    return {
      renderable: list.renderable,
      items: list.items.map(toCandidateResponse),
    };
  }

  @Throttle(AI_THROTTLE)
  @Post('sermons/:sermonId/reel-candidates')
  @HttpCode(202)
  async regenerate(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', ParseIdPipe) sermonId: string,
  ) {
    await this.regenerateCandidates.execute(churchId, sermonId);
    return { status: 'queued' as const };
  }

  @Post('reels')
  async create(
    @CurrentChurchId() churchId: string,
    @Body(zod(CreateBody)) body: z.infer<typeof CreateBody>,
  ) {
    const reel = await this.createReel.execute(churchId, body);
    return toReelResponse(await this.presenter.view(reel));
  }

  @Get('reels')
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    const { sermonId, status, page, pageSize } = query;
    return toPaginated(
      await this.listReels.execute(
        churchId,
        { sermonId, status },
        pageRequest({ page, pageSize }),
      ),
      (reel) => toReelResponse(this.presenter.summary(reel)),
    );
  }

  @Get('reels/:id')
  async get(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return toReelResponse(
      await this.presenter.view(await this.getReel.execute(churchId, id)),
    );
  }

  @Patch('reels/:id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body(zod(PatchBody)) body: z.infer<typeof PatchBody>,
  ) {
    return toReelResponse(
      await this.presenter.view(
        await this.updateReel.execute(churchId, id, body),
      ),
    );
  }

  /** Hook copy only: never renders video. */
  @Throttle(AI_THROTTLE)
  @Post('reels/:id/hooks')
  @HttpCode(200)
  async hooks(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return { hooks: await this.generateHooks.execute(churchId, id) };
  }

  @Post('reels/:id/render')
  @HttpCode(202)
  async render(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return toReelResponse(
      await this.presenter.view(await this.requestRender.execute(churchId, id)),
    );
  }

  @Post('reels/:id/approve')
  @HttpCode(200)
  async approve(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return toReelResponse(
      await this.presenter.view(await this.approveReel.execute(churchId, id)),
    );
  }

  @Delete('reels/:id')
  @HttpCode(204)
  async remove(
    @CurrentChurchId() churchId: string,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.deleteReel.execute(churchId, id);
  }
}
