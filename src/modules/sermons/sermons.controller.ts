import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { type PaginatedResponse, pageRequest, toPaginated } from '../../shared/infrastructure/http/pagination.js';
import { ParseIdPipe } from '../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import {
  CreateSermonBody, ListQuery, type SermonResponse, type SermonStatus, type SermonStatusInfo, toIntelligenceResponse,
  toSegmentResponse, toSermonResponse, UpdateSermonBody,
} from './helper.js';
import { SermonsService } from './sermons.service.js';

@ApiTags('sermons')
@Controller('sermons')
export class SermonsController {
  constructor(@Inject(SermonsService) private readonly sermons: SermonsService) {}

  @Post()
  @HttpCode(202)
  create(
    @CurrentChurchId() churchId: string,
    @Body(zod(CreateSermonBody)) body: z.infer<typeof CreateSermonBody>,
  ): Promise<{ id: string }> {
    return this.sermons.create(churchId, body);
  }

  @Get()
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>,
  ): Promise<PaginatedResponse<SermonResponse>> {
    const page = await this.sermons.list(
      churchId,
      { statuses: query.status as SermonStatus[] | undefined, q: query.q || undefined },
      pageRequest(query),
    );
    return toPaginated(page, toSermonResponse);
  }

  @Get(':id')
  async get(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string): Promise<SermonResponse> {
    return toSermonResponse(await this.sermons.get(churchId, id));
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
    @Body(zod(UpdateSermonBody)) body: z.infer<typeof UpdateSermonBody>,
  ): Promise<SermonResponse> {
    return toSermonResponse(await this.sermons.update(churchId, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string): Promise<void> {
    await this.sermons.remove(churchId, id);
  }

  @Get(':id/status')
  status(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string): Promise<SermonStatusInfo> {
    return this.sermons.status(churchId, id);
  }

  @Post(':id/status/retry')
  @HttpCode(202)
  retry(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string): Promise<SermonStatusInfo> {
    return this.sermons.retry(churchId, id);
  }

  @Get(':id/transcript')
  async transcript(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string) {
    return (await this.sermons.transcript(churchId, id)).map(toSegmentResponse);
  }

  @Get(':id/intelligence')
  async intelligence(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Sermon')) id: string) {
    return toIntelligenceResponse(await this.sermons.intelligenceOf(churchId, id));
  }
}
