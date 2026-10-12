import { Module } from '@nestjs/common';
import {
  GetAnalyticsUseCase,
  GetDashboardUseCase,
} from './application/use-cases/analytics.use-cases.js';
import { AnalyticsController } from './presentation/http/analytics.controller.js';

@Module({
  controllers: [AnalyticsController],
  providers: [GetAnalyticsUseCase, GetDashboardUseCase],
})
export class AnalyticsModule {}
