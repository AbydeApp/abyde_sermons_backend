import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { toSermonResponse } from '../../../sermons/presentation/http/sermon.responses.js';
import {
  GetAnalyticsUseCase,
  GetDashboardUseCase,
} from '../../application/use-cases/analytics.use-cases.js';

@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(
    @Inject(GetDashboardUseCase)
    private readonly dashboard: GetDashboardUseCase,
    @Inject(GetAnalyticsUseCase)
    private readonly analytics: GetAnalyticsUseCase,
  ) {}

  @Get('dashboard')
  async getDashboard(@CurrentChurchId() churchId: string) {
    const view = await this.dashboard.execute(churchId);
    return {
      ...view,
      latestSermon: view.latestSermon
        ? toSermonResponse(view.latestSermon)
        : null,
    };
  }

  @Get('analytics')
  getAnalytics(@CurrentChurchId() churchId: string) {
    return this.analytics.execute(churchId);
  }
}
