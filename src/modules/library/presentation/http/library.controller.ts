import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
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
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import { toSermonResponse } from '../../../sermons/presentation/http/sermon.responses.js';
import { AskMinistryUseCase } from '../../application/use-cases/ask-ministry.use-case.js';
import {
  GetLibraryFacetsUseCase,
  SearchLibraryUseCase,
  SemanticSearchUseCase,
} from '../../application/use-cases/library.use-cases.js';

const optionalText = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((value) => value || undefined);
const filters = {
  speaker: optionalText,
  series: optionalText,
  scripture: optionalText,
  theme: optionalText,
  tag: optionalText,
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  ...pageQuery,
};

const SearchBody = z.object(filters);
const SemanticBody = z.object({
  query: z
    .string({ error: 'Search text is required' })
    .trim()
    .min(1, 'Search text is required')
    .max(500),
  ...filters,
});
const AskBody = z.object({
  question: z
    .string({ error: 'Ask a question' })
    .trim()
    .min(3, 'Ask a question')
    .max(1000),
});

@ApiTags('library')
@Controller()
export class LibraryController {
  constructor(
    @Inject(SearchLibraryUseCase) private readonly search: SearchLibraryUseCase,
    @Inject(SemanticSearchUseCase)
    private readonly semanticSearch: SemanticSearchUseCase,
    @Inject(GetLibraryFacetsUseCase)
    private readonly getFacets: GetLibraryFacetsUseCase,
    @Inject(AskMinistryUseCase) private readonly ask: AskMinistryUseCase,
  ) {}

  @Post('library/search')
  @HttpCode(200)
  async searchLibrary(
    @CurrentChurchId() churchId: string,
    @Body(zod(SearchBody)) body: z.infer<typeof SearchBody>,
  ) {
    const { page, pageSize, ...rest } = body;
    return toPaginated(
      await this.search.execute(
        churchId,
        rest,
        pageRequest({ page, pageSize }),
      ),
      toSermonResponse,
    );
  }

  @Throttle(AI_THROTTLE)
  @Post('library/semantic-search')
  @HttpCode(200)
  async semantic(
    @CurrentChurchId() churchId: string,
    @Body(zod(SemanticBody)) body: z.infer<typeof SemanticBody>,
  ) {
    const { page, pageSize, query, ...rest } = body;
    return toPaginated(
      await this.semanticSearch.execute(
        churchId,
        query,
        rest,
        pageRequest({ page, pageSize }),
      ),
      toSermonResponse,
    );
  }

  @Get('library/facets')
  facets(@CurrentChurchId() churchId: string) {
    return this.getFacets.execute(churchId);
  }

  @Throttle(AI_THROTTLE)
  @Post('ask')
  @HttpCode(200)
  askQuestion(
    @CurrentChurchId() churchId: string,
    @Body(zod(AskBody)) body: z.infer<typeof AskBody>,
  ) {
    return this.ask.execute(churchId, body.question);
  }
}
