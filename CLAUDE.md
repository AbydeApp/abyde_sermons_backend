# NestJS Backend Rules

## Architecture
- NestJS app, built hexagonal (ports and adapters).
- Follow the SOLID principles.
- Clear architectural principles and layers.
- Sound system design.
- No `Scope.REQUEST` providers unless there is no alternative: request scope spreads to everything that injects the provider, up to the controllers, and rebuilds that part of the graph on every request. For per-request data (trace id, current user, `churchId`) use `AsyncLocalStorage` / `nestjs-cls`; for per-tenant instances use durable providers.

## Configuration and secrets
- Validate every environment variable against a Zod schema at boot through `ConfigModule` (`validationSchema` on Nest 12, `validate` on earlier versions). A missing or malformed value must stop the process before it takes traffic.
- Read required values with `config.getOrThrow()`, never `config.get()`.
- Secrets are injected at runtime from the platform's secret store. Never bake them into the image: no `.env` copied in, no Docker `ARG`/`ENV` for secrets. Keep `.env*` in `.dockerignore`.
- Never log the config object or any secret value. If loaded config needs inspecting, log the keys only.

## Engineering concerns
- Caching
- Memory management
- Race conditions
- Retry logic
- Proper idempotency; make every operation idempotent.

### Idempotent writes
- Any endpoint that must not run twice (payments, anything that sends a message or moves money) requires an `Idempotency-Key` header and rejects requests without one.
- Keys are scoped per user/church so two clients can never collide or read each other's stored results.
- Contract: same key and same body replays the stored response without running the handler; same key with a different body is a 422; a duplicate arriving while the first is still running is a 409 with `Retry-After`; 5xx responses are not stored, so a server-side failure can be retried.
- Idempotency records live in a shared store (Postgres or Redis), never in process memory: a retry can land on another replica or arrive after a deploy.

### Timeouts, retries and failing dependencies
- Every outbound call has an explicit timeout: HTTP (`AbortSignal.timeout()` or a per-client timeout), database queries (statement timeout), Redis, and every AI/storage/payment provider.
- Pass the `AbortSignal` down to the actual I/O so a timed-out attempt really stops instead of running on in the background.
- Exactly one layer owns retries for a given call. Stacked retries multiply (3 attempts around a client that retries 3 times is 9 calls). Timeouts are per attempt, so total time = timeout x attempts and must fit the caller's budget.
- Only retry operations that are safe to repeat; use exponential backoff.
- Unreliable dependencies get a circuit breaker, a concurrency cap (bulkhead) and/or a fallback, so one slow provider cannot occupy every request on the process. This lives in the adapter behind the port, not in domain or use-case code.

### Memory and payload bounds
- Set `--max-old-space-size` explicitly to roughly 75% of the container memory limit, so a leak ends in a heap-out-of-memory error with a stack trace rather than a silent kernel kill (exit 137).
- Every list endpoint has a default page size and a hard maximum in its schema (for example `limit` 1–100, default 20). Bulk endpoints cap the number of ids they accept.
- Do not raise the global body size limit (JSON default is 100 KB) for the sake of one route. Stream large payloads on the route that needs them, or upload directly to object storage.

## API security
- Security best practices throughout.
- CORS
- Rate limiting
- SQL injection: use parameterised queries or ORM safeguards.
- Firewalls
- CSRF
- XSS
- Authentication is deny-by-default: one global guard registered with `APP_GUARD`, and routes opt out with `@Public()`. Never rely on per-controller `@UseGuards()` for auth. Every new `@Public()` must be deliberate and called out in review.
- Security headers are on (CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`): `app.useSecurityHeaders()` on Nest 12, `helmet` otherwise. Call it once, before `app.listen()`.
- CORS lists its allowed origins explicitly. Never call `app.enableCors()` with no arguments; use `credentials: true` only together with an explicit origin list.
- Rate limiting is global (`ThrottlerGuard` via `APP_GUARD`) with tighter limits on login, password reset and anything that sends email or SMS. Throttler storage is shared (Redis), otherwise the effective limit is multiplied by the number of replicas.
- Set `trust proxy` to the real number of proxies in front of the app, never `true`. Without it every client shares the load balancer's IP and `req.protocol` is wrong; with `true` a client can choose its own IP.
- Zod `z.object()` strips unknown keys; use `z.strictObject()` where unknown keys should be rejected. Never pass a raw request body to a repository.
- Controllers never return Prisma models or raw query results. Map to explicit response DTOs so newly added columns cannot leak.
- Swagger is disabled, or behind authentication, in production.

## Database
- Index the database properly.
- Ensure no data loss when making changes to the database.
- Production schema changes go only through reviewed migrations (`prisma migrate deploy`). Never `prisma db push` against production data.
- Migrations run as a separate deploy step before the new version starts (CI step, release phase or job), never from application startup, where replicas would race each other.
- Migrations must be backward compatible with the version still running. Dropping or renaming a column is split into expand and contract steps across two deploys.
- The previous image must always be redeployable against the current schema. Do not plan on down-migrations for rollback; a deploy that cannot be rolled back this way is a deliberate, reviewed exception.
- Set the connection pool size explicitly. Pool size x peak replica count (including workers, the migration job and the old+new overlap during a deploy) must fit within Postgres `max_connections`. When it stops fitting, add a pooler such as PgBouncer instead of raising `max_connections`.
- Set a statement timeout on database connections.

## Background jobs and scheduling
- Every queue job is safe to run twice: a crash, a stalled lock or a shutdown kill re-runs it from the start.
- Set `attempts`, `backoff`, `removeOnComplete` and `removeOnFail` explicitly in BullMQ `defaultJobOptions`. BullMQ does not retry by default and keeps finished jobs in Redis forever.
- `@Cron()`, `@Interval()` and `@Timeout()` fire on every replica. Guard each scheduled job with a lock held in a shared store (Redis or Postgres) so exactly one instance runs a tick, and so a tick is skipped while the previous run is still going (`@OnOneInstance()` / `@WithoutOverlapping()` from `@nestjs/locks` on Nest 12). An in-memory lock store is never acceptable in production.
- Scheduled jobs process current state ("everything not yet exported"), not a time window ("yesterday's rows"): missed ticks are not replayed.
- For long-running locked work, pass the lock's abort signal to I/O and use its fencing token to reject writes from a holder that has lost the lock.
- Job duration must fit inside the shutdown grace period, or the grace period must be raised to cover the longest job.

## Deployment and runtime
- `app.enableShutdownHooks()` is on. Adapters close their pools, clients and workers in `onModuleDestroy` / `onApplicationShutdown`.
- Node must receive `SIGTERM` directly: exec-form `CMD ["node", "--enable-source-maps", "dist/main.js"]`, never `npm run start:prod` or shell-form `CMD`. Run with an init process (`docker run --init` or `tini`), or enable `useProcessExit: true` on the shutdown hooks.
- Image: multi-stage build (no compilers, dev dependencies or source in the runtime stage), `NODE_ENV=production`, non-root (`USER node`). Copy `package.json` into the runtime stage: this is an ESM project and Node reads `"type": "module"` from it.
- Drain before closing: add a short pre-stop delay (about 5 s) so the load balancer stops routing before the server shuts down. That delay counts against the termination grace period.
- Health checks: liveness and readiness are separate endpoints. Liveness never checks the database or Redis (a dependency outage must not restart every instance). Readiness does check them.

## Errors and observability
- The exception filter that maps `DomainError` to HTTP extends `BaseExceptionFilter` and delegates everything it does not recognise, so unknown errors stay an opaque 500 and are still logged. Never write a catch-all filter from scratch.
- Unhandled rejections crash the process; do not swallow them. The error is logged with its stack before exit, and repeated restarts and OOM kills raise an alert.
- Run Node with `--enable-source-maps` so stack traces point at `.ts` files and lines.
- Logs are structured JSON with production log levels and a trace/request id on every line.
- The service is monitored: per-route latency and error rate, traces showing which method or query took the time, alerts on new errors, and visibility into queue jobs and scheduled runs. Health-check routes are excluded from latency metrics.

## Dependencies
- Run a supported Node LTS release. Pin the major in the base image and rebuild regularly so patch releases reach production.
- All `@nestjs/*` packages stay on matching versions.
- Commit the lockfile; install with `npm ci` in CI and in the image.
- Run `npm audit --omit=dev` in CI.
- Take dependency updates continuously as small PRs (Renovate or Dependabot) rather than as one large upgrade.

## Tests
- Unit tests.
- No test file clears the database.
- No test writes to the database directly.
- Global pipes, guards, interceptors and filters are registered as `APP_PIPE` / `APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER` providers, not with `app.useGlobal*()` in `main.ts`, so `createTestApp` gets the same behaviour as production.
- Shared stores introduced for locks, idempotency records and rate limiting sit behind ports and have in-memory implementations in `test/support/`.

## Project specification
- Full product/API spec and build stages B01–B34: [docs/SPEC.md](docs/SPEC.md). Architecture decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Migration policy: [docs/MIGRATIONS.md](docs/MIGRATIONS.md).
- Run `npm run verify` (lint, typecheck, unit + e2e tests, build) before finishing any change.

## Conventions in this codebase
- Hexagonal: domain never imports NestJS/Prisma/Redis/BullMQ/AI/storage/payment SDKs. Controllers and queue handlers only call use cases. Providers sit behind ports.
- Ports are bound to adapters only in `src/composition/` (Prisma repos, external providers, core infra). Add a new adapter there, not in business modules.
- Every repository method takes `churchId` and filters by it; derive `churchId` with `@CurrentChurchId()`, never from request input.
- Tests use the in-memory infrastructure in `test/support/` (`createTestApp`, `Client`). Any new port needs an in-memory implementation there. Tests never touch a real database.
- Validate HTTP input with Zod via `@Body(zod(schema))`; throw `DomainError` (never HttpException) from domain/application code.
- Vitest (esbuild) does not emit decorator metadata: always use explicit `@Inject(TOKEN)` for DI.
- ESM project: relative imports need the `.js` extension.
- `prisma migrate dev` will try to drop the hand-written trigram/HNSW indexes: remove those lines; `npm run db:check` guards this.
