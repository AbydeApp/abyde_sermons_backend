import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { toSermonResponse } from '../sermons/helper.js';
import { AnalyticsService } from './analytics.service.js';

@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  async dashboard(@CurrentChurchId() churchId: string) {
    const view = await this.analytics.dashboard(churchId);
    return { ...view, latestSermon: view.latestSermon ? toSermonResponse(view.latestSermon) : null };
  }

  @Get('analytics')
  summary(@CurrentChurchId() churchId: string) {
    return this.analytics.summary(churchId);
  }
}
