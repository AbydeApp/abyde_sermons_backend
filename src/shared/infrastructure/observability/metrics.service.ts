import { Injectable } from '@nestjs/common';
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import type { AICallObserver } from '../ai/metered-language-model.js';
import type { JobObserver } from '../queue/job-observer.js';

/** Prometheus metrics: HTTP latency, job outcomes, queue depth, AI latency/cost/failures. */
@Injectable()
export class MetricsService implements JobObserver, AICallObserver {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly jobs = new Counter({
    name: 'jobs_total',
    help: 'Background jobs by outcome',
    labelNames: ['queue', 'job', 'outcome'],
    registers: [this.registry],
  });
  private readonly jobDuration = new Histogram({
    name: 'job_duration_seconds',
    help: 'Background job duration',
    labelNames: ['queue', 'job'],
    buckets: [0.1, 1, 5, 15, 60, 300, 900, 1800],
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({
    name: 'queue_jobs',
    help: 'Jobs per queue and state',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });
  private readonly aiCalls = new Counter({
    name: 'ai_calls_total',
    help: 'AI provider calls',
    labelNames: ['operation', 'provider', 'status'],
    registers: [this.registry],
  });
  private readonly aiLatency = new Histogram({
    name: 'ai_call_duration_seconds',
    help: 'AI provider latency',
    labelNames: ['operation', 'provider'],
    buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });
  private readonly aiCost = new Counter({
    name: 'ai_estimated_cost_usd_total',
    help: 'Estimated AI spend (USD)',
    labelNames: ['operation', 'provider'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  completed(queue: string, jobName: string, durationMs: number): void {
    this.jobs.inc({ queue, job: jobName, outcome: 'completed' });
    this.jobDuration.observe({ queue, job: jobName }, durationMs / 1000);
  }

  failed(queue: string, jobName: string): void {
    this.jobs.inc({ queue, job: jobName, outcome: 'failed' });
  }

  observe(
    operation: string,
    provider: string,
    status: 'SUCCEEDED' | 'FAILED',
    latencyMs: number,
    cost: number,
  ): void {
    this.aiCalls.inc({ operation, provider, status });
    this.aiLatency.observe({ operation, provider }, latencyMs / 1000);
    if (cost > 0) this.aiCost.inc({ operation, provider }, cost);
  }
}
