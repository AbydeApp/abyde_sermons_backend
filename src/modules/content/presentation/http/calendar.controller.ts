import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import {
  ListCalendarUseCase,
  RescheduleCalendarItemUseCase,
  ScheduleContentUseCase,
  UnscheduleCalendarItemUseCase,
} from '../../application/use-cases/calendar.use-cases.js';
import { toCalendarResponse } from './content.responses.js';

const instant = (message: string) =>
  z
    .string({ error: message })
    .refine((value) => !Number.isNaN(Date.parse(value)), message)
    .transform((value) => new Date(value));

const RangeQuery = z.object({
  from: instant('"from" must be an ISO date-time'),
  to: instant('"to" must be an ISO date-time'),
});
const ScheduleBody = z.object({
  contentItemId: z
    .string({ error: 'Content is required' })
    .uuid('Invalid content id'),
  scheduledAt: instant('Choose a date and time'),
});
const RescheduleBody = z.object({
  scheduledAt: instant('Choose a date and time'),
});

/** Scheduling times are UTC instants; the web app converts from Africa/Lagos wall-clock time. */
@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(
    @Inject(ListCalendarUseCase)
    private readonly listCalendar: ListCalendarUseCase,
    @Inject(ScheduleContentUseCase)
    private readonly scheduleContent: ScheduleContentUseCase,
    @Inject(RescheduleCalendarItemUseCase)
    private readonly reschedule: RescheduleCalendarItemUseCase,
    @Inject(UnscheduleCalendarItemUseCase)
    private readonly unschedule: UnscheduleCalendarItemUseCase,
  ) {}

  @Get()
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(RangeQuery)) query: z.infer<typeof RangeQuery>,
  ) {
    return (
      await this.listCalendar.execute(churchId, query.from, query.to)
    ).map(toCalendarResponse);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentChurchId() churchId: string,
    @Body(zod(ScheduleBody)) body: z.infer<typeof ScheduleBody>,
  ) {
    return toCalendarResponse(
      await this.scheduleContent.execute(churchId, body),
    );
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Calendar item')) id: string,
    @Body(zod(RescheduleBody)) body: z.infer<typeof RescheduleBody>,
  ) {
    return toCalendarResponse(
      await this.reschedule.execute(churchId, id, body.scheduledAt),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Calendar item')) id: string,
  ): Promise<void> {
    await this.unschedule.execute(churchId, id);
  }
}
