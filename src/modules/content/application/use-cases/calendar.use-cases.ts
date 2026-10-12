import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  notFound,
  validationError,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { CalendarItem } from '../../domain/calendar-item.entity.js';
import {
  CALENDAR_REPOSITORY,
  type CalendarRepositoryPort,
  type CalendarRow,
  CONTENT_REPOSITORY,
  type ContentRepositoryPort,
} from '../ports/out/content-repository.port.js';

const MAX_RANGE_MS = 400 * 24 * 3600 * 1000;

@Injectable()
export class ListCalendarUseCase {
  constructor(
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
  ) {}

  execute(churchId: string, from: Date, to: Date): Promise<CalendarRow[]> {
    if (to < from) throw validationError('to', '"to" must be after "from"');
    if (to.getTime() - from.getTime() > MAX_RANGE_MS)
      throw validationError('to', 'Date range is too large');
    return this.calendar.listRange(churchId, from, to);
  }
}

@Injectable()
export class ScheduleContentUseCase {
  constructor(
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Idempotent per content item: scheduling already-scheduled content moves its existing entry. */
  async execute(
    churchId: string,
    input: { contentItemId: string; scheduledAt: Date },
  ): Promise<CalendarRow> {
    const calendarId = await this.uow.runLocked(
      `content:${input.contentItemId}`,
      async () => {
        const now = this.clock.now();
        const item = await this.contents.findById(
          churchId,
          input.contentItemId,
        );
        if (!item) throw notFound('Content');
        let entry = await this.calendar.findByContentItem(
          churchId,
          input.contentItemId,
        );
        if (entry) entry.reschedule(input.scheduledAt, now);
        else
          entry = CalendarItem.schedule({
            id: newId(),
            churchId,
            contentItemId: item.id,
            scheduledAt: input.scheduledAt,
            now,
          });
        item.schedule(input.scheduledAt, now);
        await this.contents.save(item);
        await this.calendar.save(entry);
        return entry.id;
      },
    );
    return this.row(churchId, calendarId);
  }

  async row(churchId: string, id: string): Promise<CalendarRow> {
    const [row] = await this.calendar.findRows(churchId, [id]);
    if (!row) throw notFound('Calendar item');
    return row;
  }
}

@Injectable()
export class RescheduleCalendarItemUseCase {
  constructor(
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
    @Inject(ScheduleContentUseCase)
    private readonly schedule: ScheduleContentUseCase,
  ) {}

  async execute(
    churchId: string,
    id: string,
    scheduledAt: Date,
  ): Promise<CalendarRow> {
    const entry = await this.calendar.findById(churchId, id);
    if (!entry) throw notFound('Calendar item');
    return this.schedule.execute(churchId, {
      contentItemId: entry.contentItemId,
      scheduledAt,
    });
  }
}

@Injectable()
export class UnscheduleCalendarItemUseCase {
  constructor(
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string, id: string): Promise<void> {
    const entry = await this.calendar.findById(churchId, id);
    if (!entry) throw notFound('Calendar item');
    await this.uow.runLocked(`content:${entry.contentItemId}`, async () => {
      const fresh = await this.calendar.findById(churchId, id);
      if (!fresh) return; // already removed by a concurrent request
      fresh.assertNotPublishing();
      const item = await this.contents.findById(churchId, fresh.contentItemId);
      await this.calendar.delete(churchId, id);
      if (item && item.status !== 'PUBLISHED') {
        item.unschedule(this.clock.now());
        await this.contents.save(item);
      }
    });
  }
}
