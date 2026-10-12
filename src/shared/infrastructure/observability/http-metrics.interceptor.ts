import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    // Health probes and the scrape endpoint would only dilute latency and error-rate figures.
    if (
      request.path.startsWith('/health') ||
      request.path.startsWith('/metrics')
    )
      return next.handle();
    const stop = this.metrics.httpDuration.startTimer();
    // Route templates (not raw URLs) keep label cardinality bounded.
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const record = () =>
      stop({
        method: request.method,
        route,
        status: String(http.getResponse<Response>().statusCode),
      });
    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
