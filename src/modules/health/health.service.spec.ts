import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import { HealthService } from './health.service.js';
import { CHECK_TIMEOUT_MS, type ReadinessCheck } from './helper.js';

const fake = (name: string, check: () => Promise<void>): ReadinessCheck => ({
  name,
  check,
});

const createService = (checks: ReadinessCheck[] = [], drainMs = 0) =>
  new HealthService(checks, {
    APP_SHUTDOWN_DRAIN_MS: drainMs,
  } as AppConfig);

describe('HealthService', () => {
  afterEach(() => vi.useRealTimers());

  it('is ready when every dependency is up', async () => {
    const health = createService([
      fake('database', async () => undefined),
      fake('redis', async () => undefined),
    ]);
    await expect(health.readiness()).resolves.toEqual({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('is not ready when any dependency fails', async () => {
    const health = createService([
      fake('database', async () => undefined),
      fake('redis', () => Promise.reject(new Error('down'))),
    ]);
    await expect(health.readiness()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOT_READY',
      message: 'Service is not ready.',
    });
    expect(health.liveness()).toEqual({ status: 'ok' });
  });

  it('times out an unresponsive dependency and clears the probe timers', async () => {
    vi.useFakeTimers();
    const health = createService([
      fake('database', () => new Promise<void>(() => {})),
      fake('redis', async () => undefined),
    ]);
    const result = expect(health.readiness()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOT_READY',
    });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a synchronously throwing probe as a readiness failure', async () => {
    const health = createService([
      fake('database', () => {
        throw new Error('down');
      }),
    ]);
    await expect(health.readiness()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOT_READY',
    });
  });

  it('stops probing during shutdown while liveness stays up', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    const health = createService([fake('database', check)], 500);
    await health.beforeApplicationShutdown();
    await expect(health.readiness()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOT_READY',
      message: 'Service is shutting down.',
    });
    expect(check).not.toHaveBeenCalled();
    expect(health.liveness()).toEqual({ status: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports not-ready immediately and waits for the drain delay on SIGTERM', async () => {
    vi.useFakeTimers();
    const health = createService([], 500);
    let finished = false;
    const shutdown = health.beforeApplicationShutdown('SIGTERM').then(() => {
      finished = true;
    });
    await expect(health.readiness()).rejects.toMatchObject({
      code: 'NOT_READY',
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(finished).toBe(true);
  });
});
