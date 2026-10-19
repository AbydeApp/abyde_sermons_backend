import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller.js';
import { LibraryService } from './library.service.js';

/** LIBRARY_FACETS, SEGMENT_SEARCH and GROUNDED_ANSWER are bound by the composition root. */
@Module({
  controllers: [LibraryController],
  providers: [LibraryService],
})
export class LibraryModule {}
