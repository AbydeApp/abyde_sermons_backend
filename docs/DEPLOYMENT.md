# Deployment and operations

## Topology

```
           Load balancer / TLS
                   │
          API containers × N  ──────────────┐
                   │                        │
   PostgreSQL 16+ (pgvector ≥ 0.8)     Redis 7 ──▶ BullMQ ──▶ Worker containers × N ──▶ AI / transcription / Paystack / Meta / Mailchimp
                   │                                              │
            Object storage (R2/S3, private bucket) ◀──────────────┘
```

One image, three roles:

| Role | Command | Notes |
|---|---|---|
| Migrations | image target `migrate` (`npx prisma migrate deploy`) | One-off job, runs **before** API and worker roll out. Never run from application startup. |
| API | default `CMD`: `node --enable-source-maps --max-old-space-size=384 --import ./dist/instrument.js dist/main.js` | Stateless, scale horizontally; liveness `/health`, readiness `/health/ready` |
| Worker | `node --enable-source-maps --max-old-space-size=1536 --import ./dist/instrument.js dist/worker.js` | No public port; needs ffmpeg (included) and scratch disk (`WORKER_TMP_DIR`, size for 2× the largest upload) |

Always start Node directly in exec form as above (never through `npm run` or a shell), so it receives `SIGTERM`. The image runs it under `tini`.

**Heap limit.** `--max-old-space-size` must be about 75% of the container memory limit, so a leak ends in a heap-out-of-memory error with a stack trace rather than a silent kernel kill (exit 137). The image default (384) fits a 512 MB API container; the worker example (1536) fits 2 GB. Change the flag when you change the limit.

**Secrets** are injected at runtime from the platform's secret store. Nothing secret is baked into the image: no `.env` is copied in (`.dockerignore` excludes `.env*`) and there are no build `ARG`/`ENV` secrets.

Build: `docker build --target runtime -t abyde-sermon-api .` and `docker build --target migrate -t abyde-sermon-api-migrate .`

## Release flow (`.github/workflows/deploy.yml`)

1. CI passes on `main`: lint, typecheck, unit, e2e, migrations applied to an ephemeral pgvector database, drift and destructive-migration guard, build, `npm audit`, Docker build.
2. Build and push `ghcr.io/<repo>:<sha>` and `…-migrate`.
3. `scripts/deploy.sh migrate`, then `api`, then `worker` (staging automatically; production through a manual `workflow_dispatch` approval on the protected `production` environment).
4. Poll `HEALTH_URL/health/ready`.

**To finish B33/B34, choose a host** (for example Fly.io, Render, Railway, AWS ECS or Kubernetes) and implement the three roles in `scripts/deploy.sh`. Add `DEPLOY_TOKEN` (secret) and `HEALTH_URL` (variable) to the `staging` and `production` GitHub environments. Managed services needed: Postgres with the pgvector extension, Redis with persistence (BullMQ), and a private R2/S3 bucket with a CORS rule for the web origin (PUT, GET).

## Environment per stage

Validated at startup. The process exits on invalid config. Full list with descriptions: `.env.example`.

| Variable | Staging | Production |
|---|---|---|
| `APP_ENV` | `staging` | `production`: fakes, memory storage and outbox email are rejected |
| `APP_CORS_ORIGINS`, `APP_WEB_URL`, `APP_PUBLIC_API_URL` | staging web/API URLs | production URLs |
| `AUTH_ACCESS_TOKEN_SECRET` | 32+ random characters (**required**: the dev default is rejected) | separate secret; rotating it signs everyone out of their access tokens |
| `AI_PROVIDER` / `TRANSCRIPTION_PROVIDER` | `openai` (or `fake` for cheap staging) | `openai` |
| `BILLING_PROVIDER` | `paystack` (test keys) | `paystack` (live keys + plan codes) |
| `EMAIL_PROVIDER` | `resend` | `resend` |
| `STORAGE_*` | staging bucket | production bucket |
| `PUBLISHING_ENCRYPTION_KEY` | `openssl rand -base64 32` | separate key; **back it up**: losing it invalidates stored integration tokens |
| `OBSERVABILITY_METRICS_TOKEN`, `OBSERVABILITY_SENTRY_DSN` | set | set |

Staging and production both refuse to start with: localhost or plain-http web/API/CORS URLs, the development access-token secret, the fake billing provider, a missing `PUBLISHING_ENCRYPTION_KEY`, a metrics token shorter than 24 characters, or Paystack without all three plan codes. `/metrics` returns 404 without a token outside local development.

Secrets belong in the platform's secret store, never in the repository.

## Network rules (firewall)

- Only the load balancer is public (443). API containers accept traffic from the load balancer only; workers expose no port.
- Postgres, Redis and the metrics endpoint are reachable only from the private network. Never give Redis or Postgres a public address.
- Set `APP_TRUST_PROXY_HOPS` to the real number of proxies in front of the API (1 for a single load balancer). With the wrong value, rate limits either trust a spoofed `X-Forwarded-For` or put every user in one bucket.
- The storage bucket stays private; browsers reach it only through short-lived signed URLs.
- Give worker containers CPU and memory limits (start with 1 vCPU / 2 GB): they parse uploaded media and documents.

## Provider setup checklist

- **Paystack**: create plans (Starter, Growth, Ministry, monthly NGN) and set their codes. Set the webhook URL to `https://<api>/api/v1/webhooks/billing/paystack`.
- **Meta app**: Facebook Login with `pages_show_list,pages_manage_posts,pages_read_engagement`. Redirect URI `https://<api>/api/v1/integrations/meta/callback` (and `/whatsapp/callback`). App review is required before production.
- **Mailchimp**: OAuth app with redirect `https://<api>/api/v1/integrations/email/callback`.
- **Google (YouTube)**: OAuth client with redirect `https://<api>/api/v1/integrations/youtube/callback`.
- **OpenAI**: API key. The embedding model must support 1536 dimensions (default `text-embedding-3-small`).

## Shutdown and grace periods

On `SIGTERM` an API instance reports not-ready, keeps serving for `APP_SHUTDOWN_DRAIN_MS` (default 5 s) so the load balancer stops routing to it, then closes the server, queues, Redis and database connections. Set the platform's termination grace period to at least:

- **API: 30 s** (5 s drain plus in-flight requests; the longest are AI calls with a 120 s per-attempt timeout, which clients retry).
- **Worker: 30 minutes** (`WORKER_SHUTDOWN_GRACE_MS`, default 30 min). Running jobs get that long to finish; after it their abort signal fires and the worker exits. The longest job time limit (transcription, 25 min) fits inside it.
- The worker finishes the jobs it is running before exiting. The longest job is transcription of a long sermon (several 5-minute chunk uploads). A job cut off by a shorter grace period is not lost: every job is safe to run twice and BullMQ re-runs it, but that wastes provider spend.

## Boot-time checks

A deployed instance refuses to start, with a message saying what to change, when:
- its V8 heap limit is above 85% of the container memory limit (read from cgroups); set `--max-old-space-size` to about 75% of the limit. Outside staging/production this is a warning.
- `DATABASE_POOL_MAX × DATABASE_EXPECTED_PROCESSES` is more than Postgres `max_connections` minus 5 (checked against the real database). `DATABASE_EXPECTED_PROCESSES` is required in staging and production.

## Alerts

Ready-made Prometheus alert rules are in `deploy/alerts/prometheus-rules.yml`: 5xx rate, slow routes, restart loops / OOM kills, heap near its limit, queue backlog, failing jobs, the publishing scheduler not running, AI provider failures and AI spend spikes. Load them into Prometheus/Alertmanager or any compatible service. New-error alerts come from Sentry.

## Tracing

Set `OBSERVABILITY_SENTRY_DSN` and `OBSERVABILITY_TRACES_SAMPLE_RATE`. Traces include the HTTP handler, Nest middleware, Prisma and `pg` query spans. Request bodies, cookies, auth headers and query strings are never sent (checked against a capturing endpoint: a failed request carrying a password, a session cookie and an OAuth code produced an error event and traces with none of them).

## Database connections

`DATABASE_POOL_MAX` is set explicitly per process (default 10). Pool size × peak process count must fit inside Postgres `max_connections`, counting API replicas, worker replicas, the migration job and the old + new overlap during a rolling deploy. Example: 3 API + 2 workers, doubled during a deploy, plus the migration job = 11 processes × 10 = 110 connections. When that stops fitting, put PgBouncer (transaction mode) in front instead of raising `max_connections`. Every connection also has a server-side `statement_timeout` (`DATABASE_STATEMENT_TIMEOUT_MS`, default 15 s).

## Rollback

Migrations are backward compatible with the version still running (expand, then contract in a later deploy), so the previous image can always be redeployed against the current schema. Roll back by redeploying the previous image tag; do not plan on down-migrations. A deploy that cannot be rolled back this way is a deliberate, reviewed exception.

## Operations

- **Scaling**: API by CPU or latency. Workers by queue depth (`queue_jobs{state="waiting"}`). `WORKER_CONCURRENCY` sets jobs per worker process; transcription jobs are memory-light but disk- and network-heavy.
- **Failed jobs**: kept in Redis for 7 days and visible as `queue_jobs{state="failed"}`. Sermon and generation failures are also visible to users with a retry action.
- **Tracing**: set `OBSERVABILITY_SENTRY_DSN` and `OBSERVABILITY_TRACES_SAMPLE_RATE` (for example 0.1). Traces show which handler, query or outbound call took the time.
- **Alerts to configure**: new error types in Sentry, repeated container restarts and OOM kills (exit 137), readiness failing, 5xx rate, `queue_jobs{state="waiting"}` growing, `jobs_total{outcome="failed"}` rate, `ai_calls_total{status="FAILED"}` rate, daily `ai_estimated_cost_usd_total`.
- **Backups**: daily Postgres snapshots with point-in-time recovery, and object-storage versioning on the sermon bucket.
- **Smoke test after deploy**: `npm run smoke https://<staging-api>/api/v1` (creates a throwaway account; staging only).

## Before broad production use

- Malware scanning of uploads (for example a ClamAV sidecar or the storage provider's scanning) before a sermon enters the pipeline.
- Meta app review, and Paystack live-mode activation.
- Load test of the upload → READY path at expected Sunday-afternoon peak.

## Brand Studio and social publishing

- **Fonts.** Branded cards and captions use system fonts through fontconfig. The image installs DejaVu and Liberation; install the brand fonts churches choose (e.g. Inter, Montserrat) into the worker image, otherwise rendering falls back to DejaVu Sans.
- **Worker sizing.** `video-render` runs one ffmpeg encode per worker process (`maxConcurrency: 1`) for up to 25 minutes, and `social-publish` attempts may stream large videos for up to 20 minutes. Both fit the default `WORKER_SHUTDOWN_GRACE_MS` (30 minutes); keep the platform's termination grace period at least that long.
- **Secrets.** `SOCIAL_TOKEN_ENCRYPTION_KEY` (32 bytes, base64, separate from `PUBLISHING_ENCRYPTION_KEY`) is required in staging and production once any `SOCIAL_*` provider is configured. Back it up: losing it invalidates every stored social token. Rotate by moving the old key to `SOCIAL_TOKEN_ENCRYPTION_KEYS_PREVIOUS`.
- **Provider apps.** Register `<APP_PUBLIC_API_URL>/social/oauth/<provider>/callback` as the redirect URI for each provider. Meta needs App Review for `pages_manage_posts`, `instagram_content_publish` (and the insights scopes); TikTok posts stay private until the app passes TikTok's audit (set `SOCIAL_TIKTOK_AUDITED=true` afterwards); Google keeps uploads private until the OAuth app is verified; LinkedIn Page posting needs Community Management API approval (`SOCIAL_LINKEDIN_ORGANIZATIONS=true`). Bump `SOCIAL_LINKEDIN_API_VERSION` and `SOCIAL_META_GRAPH_VERSION` before their sunset dates.
- **Media delivery.** Providers fetch media from signed URLs valid for `SOCIAL_MEDIA_URL_TTL_SECONDS`. TikTok only pulls from a verified domain: serve `churches/*/sermons/*/generated/*` (and nothing else) from a public host and set `STORAGE_PUBLIC_BASE_URL`, then verify that domain in the TikTok developer portal.

## Source retention

- **Source retention.** Original sermon uploads expire per plan (Free/Starter 3 days, Growth 14, Ministry 30; set in `billing/domain/plans.ts`), fixed at upload time. The hourly `purge-expired-sermon-sources` job (maintenance queue, one instance cluster-wide) deletes expired originals and marks `sermon_assets.deleted_at`; transcripts, intelligence, content, rendered media and publishing records are kept. Uploads made before this release have no expiry. Bucket lifecycle rules are not used for this: S3 rules filter by key prefix or tags, which cannot express per-plan durations, and the database must know when an original is gone. A lifecycle rule on `churches/*/uploads/` is unnecessary.

