import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { AI_THROTTLE } from '../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { toPresignedUploadResponse } from '../uploads/presentation/http/presigned-upload.response.js';
import { BrandService } from './brand.service.js';
import {
  BrandBody, type BrandProfileView, type MediaAssetView, nullsToUndefined, PresignBody, RenderBody,
} from './helper.js';
import { RenderService } from './render.service.js';
import { ContentService } from '../content/content.service.js';
import { toContentResponse } from '../content/helper.js';

@ApiTags('brand-studio')
@Controller('brand-studio')
export class BrandStudioController {
  constructor(@Inject(BrandService) private readonly brand: BrandService) {}

  @Get()
  get(@CurrentChurchId() churchId: string): Promise<BrandProfileView> {
    return this.brand.get(churchId);
  }

  @Put()
  update(
    @CurrentChurchId() churchId: string,
    @Body(zod(BrandBody)) body: z.infer<typeof BrandBody>,
  ): Promise<BrandProfileView> {
    const { voice, ...rest } = body;
    return this.brand.update(churchId, {
      ...rest,
      voice: voice
        ? (nullsToUndefined(voice) as Parameters<BrandService['update']>[1]['voice'])
        : undefined,
    });
  }

  @Post('assets/presign')
  @HttpCode(200)
  async presign(
    @CurrentChurchId() churchId: string,
    @Body(zod(PresignBody)) body: z.infer<typeof PresignBody>,
  ) {
    const { fileName, contentType, sizeBytes } = body;
    const presigned = await this.brand.presignAsset({ churchId, fileName, contentType, sizeBytes });
    return { assetId: presigned.assetId, ...toPresignedUploadResponse(presigned) };
  }

  @Delete('assets/:assetId')
  @HttpCode(204)
  async removeAsset(
    @CurrentChurchId() churchId: string,
    @Param('assetId', new ParseIdPipe('Brand asset')) assetId: string,
  ): Promise<void> {
    await this.brand.removeAsset(churchId, assetId);
  }
}

/** Branded media for content items: queue a render, then poll the content item until `visual` is READY. */
@ApiTags('brand-studio')
@Controller()
export class ContentMediaController {
  constructor(
    @Inject(RenderService) private readonly render: RenderService,
    @Inject(ContentService) private readonly content: ContentService,
  ) {}

  @Throttle(AI_THROTTLE)
  @Post('content/:contentId/render')
  @HttpCode(202)
  async renderContent(
    @CurrentChurchId() churchId: string,
    @Param('contentId', new ParseIdPipe('Content')) contentId: string,
    @Body(zod(RenderBody)) body: z.infer<typeof RenderBody>,
  ) {
    await this.render.requestRender(churchId, contentId, body);
    // The content item now carries `visual` (RENDERING until the worker finishes); clients poll it.
    return toContentResponse(await this.content.get(churchId, contentId));
  }

  @Get('content/:contentId/media')
  async contentMedia(
    @CurrentChurchId() churchId: string,
    @Param('contentId', new ParseIdPipe('Content')) contentId: string,
  ): Promise<MediaAssetView[]> {
    return this.render.toViews(await this.render.listContentMedia(churchId, contentId));
  }

  @Get('media/:assetId')
  async asset(
    @CurrentChurchId() churchId: string,
    @Param('assetId', new ParseIdPipe('Media asset')) assetId: string,
  ): Promise<MediaAssetView> {
    return this.render.toView(await this.render.getAsset(churchId, assetId));
  }
}
