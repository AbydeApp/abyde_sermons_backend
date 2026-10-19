import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { pageRequest, toPaginated } from '../../shared/infrastructure/http/pagination.js';
import { AI_THROTTLE } from '../../shared/infrastructure/http/route-limits.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { toSermonResponse } from '../sermons/presentation/http/sermon.responses.js';
import { AskBody, SearchBody, SemanticBody } from './helper.js';
import { LibraryService } from './library.service.js';

@ApiTags('library')
@Controller()
export class LibraryController {
  constructor(@Inject(LibraryService) private readonly library: LibraryService) {}

  @Post('library/search')
  @HttpCode(200)
  async search(@CurrentChurchId() churchId: string, @Body(zod(SearchBody)) body: z.infer<typeof SearchBody>) {
    const { page, pageSize, ...filters } = body;
    return toPaginated(
      await this.library.search(churchId, filters, pageRequest({ page, pageSize })),
      toSermonResponse,
    );
  }

  @Throttle(AI_THROTTLE)
  @Post('library/semantic-search')
  @HttpCode(200)
  async semantic(@CurrentChurchId() churchId: string, @Body(zod(SemanticBody)) body: z.infer<typeof SemanticBody>) {
    const { page, pageSize, query, ...filters } = body;
    return toPaginated(
      await this.library.semanticSearch(churchId, query, filters, pageRequest({ page, pageSize })),
      toSermonResponse,
    );
  }

  @Get('library/facets')
  facets(@CurrentChurchId() churchId: string) {
    return this.library.facets(churchId);
  }

  @Throttle(AI_THROTTLE)
  @Post('ask')
  @HttpCode(200)
  ask(@CurrentChurchId() churchId: string, @Body(zod(AskBody)) body: z.infer<typeof AskBody>) {
    return this.library.ask(churchId, body.question);
  }
}
