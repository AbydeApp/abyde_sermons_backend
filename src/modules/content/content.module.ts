import { Module } from '@nestjs/common';
import { ContentGenerationService } from './adapters/content-generator.js';
import { SERMON_CONTEXT, SermonContextAdapter } from './adapters/sermon-context.adapter.js';
import { CalendarController, ContentController, GenerationController } from './content.controller.js';
import { ContentService } from './content.service.js';
import { GenerationService } from './generation.service.js';

/** Content lifecycle: generation, edit + versions, calendar. Repositories are bound by the composition root. */
@Module({
  controllers: [ContentController, GenerationController, CalendarController],
  providers: [
    { provide: SERMON_CONTEXT, useClass: SermonContextAdapter },
    ContentGenerationService,
    ContentService,
    GenerationService,
  ],
  exports: [ContentService],
})
export class ContentModule {}
