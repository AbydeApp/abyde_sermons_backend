import { Module } from '@nestjs/common';
import { AskMinistryUseCase } from './application/use-cases/ask-ministry.use-case.js';
import {
  GetLibraryFacetsUseCase,
  SearchLibraryUseCase,
  SemanticSearchUseCase,
} from './application/use-cases/library.use-cases.js';
import { LibraryController } from './presentation/http/library.controller.js';

@Module({
  controllers: [LibraryController],
  providers: [
    SearchLibraryUseCase,
    SemanticSearchUseCase,
    GetLibraryFacetsUseCase,
    AskMinistryUseCase,
  ],
})
export class LibraryModule {}
