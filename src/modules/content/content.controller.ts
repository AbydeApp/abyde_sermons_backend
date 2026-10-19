import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { pageRequest, toPaginated } from '../../shared/infrastructure/http/pagination.js';
import { AI_THROTTLE } from '../../shared/infrastructure/http/route-limits.js';
import { ParseIdPipe } from '../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { ContentService } from './content.service.js';
import { GenerationService } from './generation.service.js';
import {
  GenerateWeekBody, ListQuery, PatchBody, RangeQuery, RescheduleBody, RewriteBody, ScheduleBody, toCalendarResponse,
  toContentResponse, toGenerationGroupResponse, toVersionResponse,
} from './helper.js';

@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get()
  async list(@CurrentChurchId() churchId: string, @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>) {
    const { page, pageSize, q, ...filter } = query;
    return toPaginated(
      await this.content.list(churchId, { ...filter, q: q || undefined }, pageRequest({ page, pageSize })),
      toContentResponse,
    );
  }

  @Get(':id')
  async get(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Content')) id: string) {
    return toContentResponse(await this.content.get(churchId, id));
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Body(zod(PatchBody)) body: z.infer<typeof PatchBody>,
  ) {
    return toContentResponse(await this.content.update(churchId, id, body));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Content')) id: string) {
    return toContentResponse(await this.content.approve(churchId, id));
  }

  @Throttle(AI_THROTTLE)
  @Post(':id/rewrite')
  @HttpCode(200)
  async rewrite(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Body(zod(RewriteBody)) body: z.infer<typeof RewriteBody>,
  ) {
    return toContentResponse(await this.content.rewrite(churchId, id, body.action));
  }

  @Throttle(AI_THROTTLE)
  @Post(':id/regenerate')
  @HttpCode(200)
  async regenerate(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Content')) id: string) {
    return toContentResponse(await this.content.regenerate(churchId, id));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Content')) id: string): Promise<void> {
    await this.content.remove(churchId, id);
  }

  @Get(':id/versions')
  async versions(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Content')) id: string) {
    return (await this.content.versions(churchId, id)).map(toVersionResponse);
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(200)
  async restore(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Content')) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return toContentResponse(await this.content.restoreVersion(churchId, id, version));
  }
}

@ApiTags('generation')
@Controller('sermons/:sermonId')
export class GenerationController {
  constructor(@Inject(GenerationService) private readonly generation: GenerationService) {}

  @Throttle(AI_THROTTLE)
  @Post('generate-week')
  @HttpCode(202)
  async generate(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', new ParseIdPipe('Sermon')) sermonId: string,
    @Body(zod(GenerateWeekBody)) body: z.infer<typeof GenerateWeekBody>,
  ) {
    return toGenerationGroupResponse(await this.generation.generateWeek(churchId, sermonId, body.contentTypes));
  }

  @Get('generations/:groupId')
  async group(
    @CurrentChurchId() churchId: string,
    @Param('sermonId', new ParseIdPipe('Sermon')) sermonId: string,
    @Param('groupId', new ParseIdPipe('Generation')) groupId: string,
  ) {
    return toGenerationGroupResponse(await this.generation.getGroup(churchId, sermonId, groupId));
  }
}

/** Scheduling times are UTC instants; the web app converts from Africa/Lagos wall-clock time. */
@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get()
  async list(@CurrentChurchId() churchId: string, @Query(zod(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return (await this.content.listCalendar(churchId, query.from, query.to)).map(toCalendarResponse);
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentChurchId() churchId: string, @Body(zod(ScheduleBody)) body: z.infer<typeof ScheduleBody>) {
    return toCalendarResponse(await this.content.schedule(churchId, body));
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Calendar item')) id: string,
    @Body(zod(RescheduleBody)) body: z.infer<typeof RescheduleBody>,
  ) {
    return toCalendarResponse(await this.content.reschedule(churchId, id, body.scheduledAt));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentChurchId() churchId: string, @Param('id', new ParseIdPipe('Calendar item')) id: string): Promise<void> {
    await this.content.unschedule(churchId, id);
  }
}
