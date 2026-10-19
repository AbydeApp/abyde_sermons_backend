import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { SERMON_MEDIA } from './adapters/ports.js';
import { SermonMediaAdapter } from './adapters/sermon-media.adapter.js';
import { BrandStudioController, ContentMediaController } from './brand.controller.js';
import { BrandService } from './brand.service.js';
import { RenderService } from './render.service.js';

/**
 * Brand Studio: brand profile and logo, plus the media pipeline (branded images, carousels,
 * captioned vertical clips). Repositories, the renderer and storage are bound by the composition root.
 */
@Module({
  imports: [ContentModule],
  controllers: [BrandStudioController, ContentMediaController],
  providers: [
    BrandService,
    RenderService,
    { provide: SERMON_MEDIA, useClass: SermonMediaAdapter },
  ],
})
export class BrandModule {}
