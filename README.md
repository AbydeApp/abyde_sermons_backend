# Abyde Sermon API

Backend for **Abyde Sermon**: turns a church's Sunday sermon into a week of ministry content (devotionals, social posts, prayers, Bible study, email, WhatsApp messages, quotes, video ideas), with sermon search and grounded "Ask your ministry" answers.

NestJS modular monolith, hexagonal (ports & adapters), PostgreSQL + pgvector, Redis + BullMQ, S3-compatible storage. API and worker run as separate processes from one codebase.

- Product/API specification: [docs/SPEC.md](docs/SPEC.md)
- Architecture and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Database migration policy: [docs/MIGRATIONS.md](docs/MIGRATIONS.md)
- Deployment and operations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Engineering rules for contributors and agents: [CLAUDE.md](CLAUDE.md)

## Local development

Requirements: Node 22 (npm 12), Docker, ffmpeg (for real media processing in the worker).

```bash
npm install                 # also generates the Prisma client
cp .env.example .env        # works as-is: fake AI/transcription/billing, local storage
docker compose up -d        # PostgreSQL+pgvector (5433), Redis (6380), S3-compatible storage (9000)
npm run storage:init        # create the private dev bucket + browser CORS rule
npm run db:migrate          # apply migrations
npm run build
npm run db:seed             # two fictional demo churches (password: DemoPass2026)
npm run start:dev           # API on http://localhost:4000 (Swagger at /docs)
npm run start:dev:worker    # worker process (separate terminal)
npm run smoke               # end-to-end check of the whole loop against the running API + worker
```

Host ports avoid clashes with a local Postgres (5432) and Redis (6379). With the default `.env`, AI, transcription and billing use deterministic fakes, so the full loop runs without API keys. Set `AI_PROVIDER=openai`, `TRANSCRIPTION_PROVIDER=openai` and `AI_OPENAI_API_KEY` to use OpenAI. Dev emails (password resets) are written to `.outbox/`.

## Commands

| Command | Purpose |
|---|---|
| `npm run start:api` / `npm run start:worker` | Run the built processes locally (source maps and tracing preload on). In containers Node is started directly, see docs/DEPLOYMENT.md |
| `npm run start:dev` / `npm run start:dev:worker` | Watch mode |
| `npm run lint` | oxlint (type-aware) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (domain, use cases, adapters) |
| `npm run test:e2e` | HTTP e2e suites over in-memory infrastructure (critical flow, cross-church isolation, auth, security, content, processing, resilience, billing, publishing) |
| `npm run verify` | lint + typecheck + all tests + build |
| `npm run db:migrate` / `npm run db:migrate:dev` | Apply migrations / create a new one (read docs/MIGRATIONS.md first) |
| `npm run db:check` | Schema-drift and destructive-migration guard (runs in CI) |
| `npm run db:seed` | Demo data (refuses to run in staging/production) |
| `npm run smoke [baseUrl]` | Live end-to-end check against a running deployment |

Tests never connect to, write to or clear a database: they run against in-memory adapters behind the same ports the Prisma adapters implement.

## Processes

- **API** (`dist/main.js`): HTTP under `/api/v1`, `/health`, `/health/ready`, `/metrics`. It only enqueues heavy work.
- **Worker** (`dist/worker.js`): consumes `sermon-processing`, `transcription`, `sermon-analysis`, `embeddings`, `content-generation`, `publishing`, `email` and `maintenance`, and runs schedulers (publishing dispatch every minute, stale-upload cleanup).

One Docker image serves both: the default command is the API, and the worker runs `node dist/worker.js`. A `migrate` image target runs `prisma migrate deploy`.

## Build stages (docs/SPEC.md §53)

| Stage | Status |
|---|---|
| B01–B02 Foundation, config, Docker deps, Prisma schema + pgvector + indexes | Done |
| B03 Authentication (cookie sessions, revocation, reset, rate limits, CSRF) | Done |
| B04 Church onboarding | Done |
| B05 Storage abstraction + presigned uploads | Done |
| B06 Sermon CRUD | Done |
| B07 Redis/BullMQ + separate worker runtime | Done |
| B08–B09 Transcription pipeline (ffmpeg chunking, documents, pasted text) + segmentation | Done |
| B10–B12 AI provider abstraction, sermon intelligence, scripture verification | Done |
| B13–B14 Embeddings + semantic search | Done |
| B15–B20 Generate My Week (independent per-type jobs, retry-safe) | Done |
| B21–B22 Content CRUD + version history, calendar | Done |
| B23 Ask Your Ministry (church-scoped RAG with citations) | Done |
| B24–B25 Usage + AI cost metering, billing (Paystack) | Done |
| B26–B27 Publishing abstraction + integrations (Meta, Mailchimp, WhatsApp, YouTube OAuth) | Done (see limits below) |
| B28 Analytics + dashboard | Done |
| B29–B30 Security hardening, observability (logs, request ids, Prometheus, Sentry) | Done |
| B31 E2E + isolation tests | Done |
| B32 CI/CD | Workflows written (`.github/workflows`), not yet run on GitHub |
| B33–B34 Staging/production deployment | Needs a hosting platform; image, migrate job, runbook and hook (`scripts/deploy.sh`) are ready |

### Known limits

- Real provider adapters (OpenAI, Paystack, Meta, Mailchimp, Google) are implemented against their documented APIs but have not been exercised with live credentials. The fakes cover the full loop.
- WhatsApp and video ideas are shared manually in V1: the calendar keeps them as a plan and nothing is auto-published. YouTube is connect-only, kept for future video and metrics work.
- Uploads are validated by type, extension and size. Malware scanning is not implemented yet (docs/DEPLOYMENT.md lists the plan).
- Swagger lists every route; request and response schemas are defined with Zod and not yet emitted into the OpenAPI document.

### Setting up GitHub (CI, deploys, Dependabot)

This folder is not a git repository yet. Every CI step passes locally on a clean copy (`npm ci`, generate, lint, typecheck, unit, e2e, migrations on an empty database, drift check, build, audit), and the workflows pass `actionlint`. To start them on GitHub:

```bash
git init && git add -A && git commit -m "Initial import"
gh repo create abyde-sermon-api --private --source . --push
```

Then add `DEPLOY_TOKEN` (secret) and `HEALTH_URL` (variable) to `staging` and `production` environments, and implement `scripts/deploy.sh` for your host. Dependabot starts automatically from `.github/dependabot.yml` once the repository exists.

### Where the API is stricter than the web contract

The web app needs small changes for these:

- `PATCH /auth/me`: changing `email` now requires `currentPassword` in the body. Without it, or with a wrong one, the response is 422 `WRONG_PASSWORD` with `errors.currentPassword`. Changing only `fullName` is unchanged.
- `POST /auth/register`: `EMAIL_TAKEN` (409) is still returned as the contract requires, but after five of them in an hour from one client the response is 429 `TOO_MANY_ATTEMPTS`.
- Documents (PDF, DOCX, TXT) upload up to 2 GB as the contract says, but a PDF or DOCX over 100 MB, or a TXT over 20 MB, fails processing with "This document is too large to read…" because documents are parsed in memory.
- `POST /billing/checkout`, `POST /billing/portal` and `POST /auth/forgot-password` require an `Idempotency-Key` header (8–128 URL-safe characters, a fresh UUID per user action). Without it they return 422 `IDEMPOTENCY_KEY_REQUIRED`.
- An unexpected server error is Nest's plain 500 body (`statusCode`, `message`), without `code`, `errors` or `requestId`; the request id is still in the `X-Request-Id` response header.
- A cross-site request is rejected with 403 `FORBIDDEN`.
- `POST /content/:id/rewrite` and `/regenerate` return 409 `CONTENT_BUSY` while another AI edit of the same item is running, and 429 `AI_LIMIT_REACHED` past the hourly per-church limit. Regenerating a quote returns 422 `NO_ALTERNATIVE` when the sermon has no other exact quote.
