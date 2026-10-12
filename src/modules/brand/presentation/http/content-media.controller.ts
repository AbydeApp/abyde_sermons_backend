import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { AI_THROTTLE } from '../../../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import { MediaPresenter } from '../../application/media-presenter.js';
import {
  GetMediaAssetUseCase,
  ListContentMediaUseCase,
  RequestContentRenderUseCase,
} from '../../application/use-cases/render.use-cases.js';
import { ASPECT_NAMES, RENDER_FORMATS } from '../../domain/templates.js';
import {
  toMediaAssetResponse,
  toRenderAcceptedResponse,
} from './brand.responses.js';

const RenderBody = z
  .strictObject({
    format: z.enum(RENDER_FORMATS, { error: 'Unknown format' }),
    templateId: z.string().max(60).optional(),
    aspect: z.enum(ASPECT_NAMES).optional(),
    clip: z
      .strictObject({
        startMs: z.number().int().min(0),
        endMs: z.number().int().positive(),
      })
      .optional(),
  })
  .refine((body) => body.format === 'video' || !body.clip, {
    message: 'Only video renders take a clip window',
    path: ['clip'],
  });

@ApiTags('brand-studio')
@Controller()
export class ContentMediaController {
  constructor(
    @Inject(RequestContentRenderUseCase)
    private readonly render: RequestContentRenderUseCase,
    @Inject(ListContentMediaUseCase)
    private readonly listMedia: ListContentMediaUseCase,
    @Inject(GetMediaAssetUseCase)
    private readonly getAsset: GetMediaAssetUseCase,
    @Inject(MediaPresenter) private readonly presenter: MediaPresenter,
  ) {}

  /** Queues rendering and returns at once; poll the assets until they are READY. */
  @Throttle(AI_THROTTLE)
  @Post('content/:contentId/render')
  @HttpCode(202)
  async renderContent(
    @CurrentChurchId() churchId: string,
    @Param('contentId', new ParseIdPipe('Content')) contentId: string,
    @Body(zod(RenderBody)) body: z.infer<typeof RenderBody>,
  ) {
    const accepted = await this.render.execute(churchId, contentId, body);
    return toRenderAcceptedResponse(
      accepted,
      await this.presenter.toViews(accepted.assets),
    );
  }

  @Get('content/:contentId/media')
  async contentMedia(
    @CurrentChurchId() churchId: string,
    @Param('contentId', new ParseIdPipe('Content')) contentId: string,
  ) {
    return (
      await this.presenter.toViews(
        await this.listMedia.execute(churchId, contentId),
      )
    ).map(toMediaAssetResponse);
  }

  @Get('media/:assetId')
  async asset(
    @CurrentChurchId() churchId: string,
    @Param('assetId', new ParseIdPipe('Media asset')) assetId: string,
  ) {
    return toMediaAssetResponse(
      await this.presenter.toView(
        await this.getAsset.execute(churchId, assetId),
      ),
    );
  }
}
