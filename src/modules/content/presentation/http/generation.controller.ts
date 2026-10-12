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
import { CONTENT_TYPES } from '../../domain/content-types.js';
import {
  GenerateWeekUseCase,
  GetGenerationGroupUseCase,
} from '../../application/use-cases/generation.use-cases.js';
import { toGenerationGroupResponse } from './content.responses.js';

const GenerateWeekBody = z.object({
  contentTypes: z
    .array(z.enum(CONTENT_TYPES, { error: 'Unknown content type' }), {
      error: 'Choose at least one content type',
    })
    .min(1, 'Choose at least one content type')
    .max(CONTENT_TYPES.length),
});

@ApiTags('generation')
@Controller('sermons/:sermonId')
export class GenerationController {
  constructor(
    @Inject(GenerateWeekUseCase)
    private readonly generateWeek: GenerateWeekUseCase,
    @Inject(GetGenerationGroupUseCase)
    private readonly getGroup: GetGenerationGroupUseCase,
  ) {}

  @Throttle(AI_THROTTLE)
  @Post('generate-week')
  @HttpCode(202)
  async generate(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', new ParseIdPipe('Sermon')) sermonId: string,
    @Body(zod(GenerateWeekBody)) body: z.infer<typeof GenerateWeekBody>,
  ) {
    return toGenerationGroupResponse(
      await this.generateWeek.execute(churchId, sermonId, body.contentTypes),
    );
  }

  @Get('generations/:groupId')
  async group(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', new ParseIdPipe('Sermon')) sermonId: string,
    @Param('groupId', new ParseIdPipe('Generation')) groupId: string,
  ) {
    return toGenerationGroupResponse(
      await this.getGroup.execute(churchId, sermonId, groupId),
    );
  }
}
