import { Module } from '@nestjs/common';
import { SERMON_MEDIA } from './application/ports/out/sermon-media.port.js';
import { MediaPresenter } from './application/media-presenter.js';
import {
  BrandProfileService,
  DeleteBrandAssetUseCase,
  GetBrandProfileUseCase,
  ListTemplatesUseCase,
  PresignBrandAssetUseCase,
  PreviewBrandUseCase,
  SetDefaultTemplateUseCase,
  UpdateBrandProfileUseCase,
} from './application/use-cases/brand-profile.use-cases.js';
import {
  GetMediaAssetUseCase,
  ListContentMediaUseCase,
  RecoverStuckRendersUseCase,
  RenderMediaGroupUseCase,
  RequestContentRenderUseCase,
} from './application/use-cases/render.use-cases.js';
import { SermonMediaAdapter } from './infrastructure/sermon-media.adapter.js';
import { BrandStudioController } from './presentation/http/brand-studio.controller.js';
import { ContentMediaController } from './presentation/http/content-media.controller.js';
import { BrandJobHandlers } from './presentation/queue/brand-job.handlers.js';

/**
 * Brand Studio: brand profile and voice, brand assets, deterministic templates, and the media
 * pipeline (branded images, carousels, captioned vertical clips). Repositories, the renderer and
 * storage are bound by the composition root.
 */
@Module({
  controllers: [BrandStudioController, ContentMediaController],
  providers: [
    BrandProfileService,
    MediaPresenter,
    GetBrandProfileUseCase,
    UpdateBrandProfileUseCase,
    PresignBrandAssetUseCase,
    DeleteBrandAssetUseCase,
    ListTemplatesUseCase,
    SetDefaultTemplateUseCase,
    PreviewBrandUseCase,
    RequestContentRenderUseCase,
    RenderMediaGroupUseCase,
    RecoverStuckRendersUseCase,
    ListContentMediaUseCase,
    GetMediaAssetUseCase,
    BrandJobHandlers,
    { provide: SERMON_MEDIA, useClass: SermonMediaAdapter },
  ],
  // Reels read the brand (look, voice, video settings) through this service.
  exports: [BrandProfileService],
})
export class BrandModule {}
