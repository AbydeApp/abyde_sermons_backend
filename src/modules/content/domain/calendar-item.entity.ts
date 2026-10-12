import { DomainError } from '../../../shared/domain/domain-error.js';

export type CalendarItemStatus =
  'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

export interface CalendarItemProps {
  id: string;
  churchId: string;
  contentItemId: string;
  scheduledAt: Date;
  status: CalendarItemStatus;
}

export const pastDate = () =>
  new DomainError(
    'UNPROCESSABLE',
    'PAST_DATE',
    'Choose a time in the future.',
    { scheduledAt: ['Choose a time in the future'] },
  );

export class CalendarItem {
  private constructor(private props: CalendarItemProps) {}

  static schedule(input: {
    id: string;
    churchId: string;
    contentItemId: string;
    scheduledAt: Date;
    now: Date;
  }): CalendarItem {
    const { now, ...props } = input;
    if (props.scheduledAt <= now) throw pastDate();
    return new CalendarItem({ ...props, status: 'SCHEDULED' });
  }

  static restore(props: CalendarItemProps): CalendarItem {
    return new CalendarItem({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get contentItemId(): string {
    return this.props.contentItemId;
  }
  get scheduledAt(): Date {
    return this.props.scheduledAt;
  }
  get status(): CalendarItemStatus {
    return this.props.status;
  }

  snapshot(): Readonly<CalendarItemProps> {
    return { ...this.props };
  }

  reschedule(at: Date, now: Date): void {
    this.assertNotPublishing();
    if (at <= now) throw pastDate();
    this.props.scheduledAt = at;
    this.props.status = 'SCHEDULED';
  }

  assertNotPublishing(): void {
    if (this.props.status === 'PUBLISHING') {
      throw new DomainError(
        'CONFLICT',
        'CONTENT_PUBLISHING',
        'This content is being published right now.',
      );
    }
  }
}
