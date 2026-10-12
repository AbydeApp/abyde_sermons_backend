/**
 * Preloaded with `node --import ./dist/instrument.js` so error monitoring and tracing are set up
 * before any application module is imported (auto-instrumentation of HTTP, Postgres and Redis
 * needs that). It runs before the Nest ConfigModule exists, so it reads its three variables
 * directly; they are still validated with the rest of the environment at boot.
 */
import { initErrorReporting } from './shared/infrastructure/observability/error-reporter.js';

const sampleRate = Number(process.env.OBSERVABILITY_TRACES_SAMPLE_RATE ?? 0);
initErrorReporting(
  process.env.OBSERVABILITY_SENTRY_DSN || undefined,
  process.env.APP_ENV ?? 'development',
  process.env.APP_RELEASE,
  Number.isFinite(sampleRate) ? Math.min(Math.max(sampleRate, 0), 1) : 0,
);
