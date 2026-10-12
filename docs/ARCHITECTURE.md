# Architecture and design decisions

## Shape

Modular monolith with hexagonal architecture inside each module. Dependencies point inward:

```
presentation (HTTP controllers, queue handlers)  ─┐
infrastructure (Prisma, Redis, BullMQ, S3, AI)   ─┼─▶ application (use cases, ports) ─▶ domain (entities, rules)
```

```
src/
├── main.ts / worker.ts / seed.ts        process entry points (API, worker, dev seed)
├── app.module.ts                        AppModule.register({ infrastructure }) — business modules + adapters
├── composition/                         composition root: the ONLY place ports are bound to adapters
│   ├── core-infrastructure.module.ts    Prisma, Redis, cache, BullMQ queue, unit of work, clock, crypto, metrics
│   ├── prisma-persistence.module.ts     every repository port → Prisma adapter
│   └── external-providers.module.ts     storage, AI, transcription, media, payments, OAuth, publishers, email
├── modules/<module>/
│   ├── domain/                          entities + invariants (no framework imports)
│   ├── application/{ports,use-cases,services}
│   ├── infrastructure/                  adapters for this module's ports
│   └── presentation/{http,queue}        controllers and job handlers (inbound adapters)
└── shared/{domain,application,infrastructure}
```

Modules: `auth`, `church`, `uploads`, `sermons` (transcripts, intelligence, scriptures, embeddings, pipeline, source retention), `content` (generation, content, versions, calendar), `library` (search, semantic search, ask), `usage`, `billing` (plans and entitlements), `integrations`, `publishing`, `brand` (Brand Studio, media pipeline), `social` (direct social publishing), `reels` (Reel candidates, hooks, branded 9:16 renders), `analytics`, `health`, `system` (metrics, email, maintenance jobs).

Rules enforced in code review and by structure:

- Domain code imports nothing from NestJS, Prisma, BullMQ, Redis or provider SDKs.
- Controllers authenticate, validate with Zod, call one use case and map the response. They contain no business rules.
- Queue handlers (`presentation/queue`) translate a payload into one use-case call.
- Repositories map Prisma rows ⇄ domain entities. Business rules stay in entities and use cases.
- Swapping a vendor (OpenAI → Anthropic, R2 → S3, Paystack → other) only touches `composition/external-providers.module.ts` and a new adapter.

Cross-module dependencies run one way and go through ports: content reads sermons through `SermonContextPort`; publishing uses content's repositories and the integrations credential service. Three modules are `@Global` for read-only cross-cutting ports: church (`CHURCH_DIRECTORY`, `CHURCH_PROFILE`), billing (`SERMON_QUOTA`) and integrations (credentials). This avoids import cycles.

## Tenancy and authorization

- V1 is one user → one church. `churchId` is derived server-side from the session (`@CurrentChurchId()`) and never read from client input; unknown body fields are stripped by Zod.
- Every repository method takes `churchId` and puts it in the `WHERE` clause. A foreign resource is indistinguishable from a missing one (404). Vector search filters `church_id` inside the ANN query and joins `sermons` on `church_id` and `status = READY`.
- Storage keys are `churches/<churchId>/…`. Keys returned by the browser are accepted only if an `uploads` row issued that key to this church for this purpose, the key is unused, and the object exists within the size limit.
- `test/isolation.e2e-spec.ts` (mandatory) and `church-scoping.spec.ts` (every Prisma query carries `churchId`) enforce this.

## Sessions and HTTP security

- Opaque random session token in an `HttpOnly; Secure; SameSite=Lax` cookie. Only the SHA-256 hash is stored. Sessions are revocable (logout, password change and reset revoke them), cached in Redis for 60s, and the cache entry is evicted on revocation.
- Passwords use scrypt (N=2^15). Login takes the same time whether or not the email exists (a dummy hash is checked), errors are generic, failures lock out per email, and credential routes have a per-IP throttle.
- CSRF: state-changing requests must carry an allow-listed `Origin` (or no cross-site `Sec-Fetch-Site`).
- Helmet (strict CSP when Swagger is off), CORS allowlist with credentials, 2 MB JSON limit, `trust proxy` hops configurable.
- Global rate limiting uses Redis-backed counters (shared across API replicas). AI and credential routes have tighter budgets.
- One error envelope (`statusCode, code, message, errors, requestId`). Stack traces, SQL and provider errors never reach clients. 5xx errors go to Sentry with bodies and cookies stripped.
- Integration credentials are AES-256-GCM sealed at rest and never returned. OAuth `state` is random, single-use and expires in 10 minutes, and the callback must arrive with a session for the church that started the flow (an authorisation link sent to someone else connects nothing).
- Revoking a session leaves a short-lived tombstone in Redis so a request that was mid-flight cannot re-cache it. Changing the sign-in email or password invalidates outstanding reset links; an email change also signs out other devices and notifies the previous address.
- Presigned upload URLs sign both `Content-Type` and `Content-Length`, so storage itself rejects a different type or a larger file. The worker re-checks the stored size before downloading.
- Credential routes are excluded from idempotency storage (their bodies contain passwords).
- Changing the sign-in email requires the current password.
- Login lockout is counted per email and client IP (10 failures in 15 minutes), so nobody can lock the owner out from elsewhere; a ceiling of 50 failures per email across all IPs still stops distributed guessing.
- Account enumeration is bounded: `EMAIL_TAKEN` is returned (the contract requires it) at most five times an hour per client, and forgot-password does identical work on the request path for every address (lookup, token and email happen in a background job).
- Append-only operational tables are pruned daily: webhook delivery records after 90 days, AI cost logs after 400 days, expired sessions and reset tokens after 30 days.
- Documents are accepted up to the contract's 2 GB but parsed only up to 100 MB (PDF, DOCX) or 20 MB (TXT); larger ones fail with a clear message instead of exhausting worker memory.
- AI spend is bounded per church (120 rewrites/regenerations and 30 generate-week requests per hour) on top of the per-IP throttles, and one item can have only one AI edit in flight.
- ffmpeg/ffprobe run with `-protocol_whitelist file`, so an uploaded playlist cannot make them fetch URLs.

## Asynchronous pipeline

`POST /sermons` returns 202 once the upload is verified and the sermon row exists. The worker then runs three phases, each its own queue so each retries independently:

| Phase (queue) | Stages | Output |
|---|---|---|
| `transcription` | MEDIA → TRANSCRIBE | ffmpeg → mono 16 kHz chunks (20 min, about 5 MB) → speech-to-text with timestamps → cleaned, sentence-aligned 45–120 s segments. PDF, DOCX, TXT and pasted text get estimated timings. |
| `sermon-analysis` | UNDERSTAND → SCRIPTURES → INTELLIGENCE | One structured, schema-validated model call, then guardrails (below), then verified scripture references, persisted intelligence and denormalised themes and scriptures for search |
| `embeddings` | INDEX → READY | Batched (64) segment embeddings → pgvector |

Correctness under retries and crashes:

- Sermon writes are targeted and guarded, never whole-row upserts. User edits write only detail columns. Worker writes touch only processing columns and apply only while the stored sermon is still processing in the same run; otherwise the job stops quietly. A worker therefore cannot resurrect a deleted sermon, overwrite an edit or regress a finished sermon.
- Each run has a `processingAttempts` number. Jobs carry it and deterministic job ids (`sermon.<id>.<attempt>.<phase>`), so stale jobs from a superseded run are ignored and duplicates are not enqueued.
- Phases are idempotent. Transcription is skipped if segments already exist. Writes replace (delete then insert) inside one transaction, so a re-run never duplicates rows.
- Transient errors are retried with exponential backoff (per-queue policy). On the final attempt, or on a `PermanentJobError`, the sermon is marked `FAILED` at the stage it reached, with a user-safe message. `POST /status/retry` resumes from that stage.
- Lost work is recovered: a maintenance job (every 10 minutes) marks sermons with no progress for 2 hours, and generation jobs with none for 30 minutes, as FAILED and retryable. If the queue is unavailable when a sermon is created, the sermon is marked FAILED and retryable straight away instead of returning a 500.
- Media streams from storage to disk. Chunks are transcribed sequentially, and the scratch directory is always removed, so memory stays flat for 2 GB uploads.

## Generate My Week

`POST /sermons/:id/generate-week` creates a generation group with one job per content type. There is never one giant call.

- The request runs under a per-sermon advisory lock. `planGeneration` decides between reusing the latest group and starting a new one: on reuse, only FAILED types are re-queued, in-flight and completed types are left alone, and new types are added. `UNIQUE(group_id, content_type)` is the backstop against duplicates.
- A worker job deletes any partial output from an earlier attempt of the same job, inserts the items and their first versions, and marks the job COMPLETED, all in one transaction. Usage is metered with a dedupe key, so retries count once.
- One type failing never affects the others. Job states are QUEUED, PROCESSING, RETRYING, COMPLETED and FAILED.

## AI guardrails (application level, not just prompts)

- All important outputs (analysis, content, rewrite, quotes, answers) use strict JSON-schema structured output and are re-validated with Zod before anything is persisted.
- **Scripture**: validity comes from a canonical verse table (66 books, 1,189 chapters, verse counts checked against known totals in tests), never from the model. Unverifiable references are stored unverified and never displayed. In generated content they become `null`.
- **Quotes**: kept only if the text appears verbatim (ignoring case and punctuation) in the cited transcript segment. Quote content is `source.verbatim = true`. All AI prose is `false`, so the UI never presents generated text as the pastor's words.
- **Evidence**: model segment references are mapped to real segment ids of the same sermon. Unknown references are dropped.
- **Grounding**: generation context is only this sermon of this church. Ask retrieves only this church's segments, returns "the archive doesn't cover this" without calling the model when nothing is relevant, and returns no sources when the model reports insufficient evidence.
- Prompts include the church's tone, translation, audience, words to avoid and extra context.
- Every call writes an `ai_usage_logs` row (operation, provider, model, tokens, estimated cost, latency, status) plus a customer usage event. Prompts and responses are never logged.

## Content lifecycle

`DRAFT → APPROVED → SCHEDULED → PUBLISHED | FAILED` (and `ARCHIVED`). Every title or body change (user edit, AI rewrite, regenerate, restore) appends a `content_versions` row. History is never rewritten, and `UNIQUE(content_item_id, version)` rejects a concurrent writer. Editing approved or scheduled content returns it to DRAFT and deletes its calendar entry. Re-approving content whose publish failed also clears the stale entry. Changing a quote's body clears `source.verbatim`, and regenerating a quote always picks a different verified quote. Published content is read-only. Each item's mutations are serialised with a per-item lock.

## Publishing

A worker scheduler runs every minute. It atomically claims due calendar items (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`) for types that have an automatic channel, and enqueues one publish job each. Publishing runs exactly once:

- The idempotency key is `<calendarItemId>:<scheduledAt>`, unique in `publish_attempts`. Queue job ids are unique per claim (BullMQ silently drops an id that matches a retained job), so exactly-once rests on the attempts table alone.
- Credentials and adapter are resolved before the attempt row is written, so a pre-flight error is retryable and never reads as "outcome unknown".
- Adapters classify failures. A 4xx is a definite rejection (429 is retried). A 5xx, a timeout, an adapter exception or an interrupted `PENDING` attempt is "outcome unknown" and is never retried automatically: the item is marked FAILED with a "check before rescheduling" message, because a duplicate public post is worse than a visible failure.
- Stale claims (worker died before starting an attempt) are released after 30 minutes.

Channels: Facebook Page (devotional, social, quote, prayer), Mailchimp (email, Bible study). WhatsApp and video ideas are manual in V1.

## Idempotency for every write

- Natural idempotency: approve, logout, disconnect, unschedule, re-scheduling the same item and webhook replays are no-ops.
- Client idempotency: any POST, PATCH or DELETE carrying `Idempotency-Key` returns the stored 2xx result for the same user, route and key for 24 hours. A concurrent duplicate gets 409, and reusing a key with a different body gets 422.
- Background idempotency: deterministic job ids, replace-on-retry writes, usage dedupe keys, the webhook event table and publish attempts.

## Race conditions

Transaction-scoped Postgres advisory locks (`UnitOfWork.runLocked`) serialise read-check-write sequences: sermon creation per church (plan quota plus upload consumption), church creation per user, generation per sermon, and mutations per content item. Unique constraints back up every invariant. Conditional updates (`updateMany … WHERE consumed_at IS NULL`) make single-use tokens and uploads safe under concurrency.

## Caching

Redis cache-aside with short TTLs and explicit eviction: sessions (60 s, evicted on revoke), user → church id (1 h, positive only), library facets (60 s), analytics (30 s), and query embeddings (24 h, which saves provider cost on repeated searches). BullMQ keeps recent job history and then expires it, which bounds Redis memory.

## Billing

Plans live in code (`free` 2 sermons/month, `starter` 6, `growth` 15, `ministry` 40). Usage is shown in sermons and content pieces, never tokens. A successful charge only counts if its amount and currency cover the plan price. Events for one church are applied under a per-church lock, and a renewal charge starts a new usage period. The entitlement rules: paid plans apply while active, or non-renewing until period end, or past-due within 3 days of grace. Otherwise the free plan applies per Africa/Lagos calendar month. Paystack webhooks are HMAC-SHA512 verified over the raw body and recorded in `webhook_events` in the same transaction as their effects (replay-safe). Events for unknown customers return 503 so Paystack redelivers. The frontend's payment status is never trusted.

## Observability

pino JSON logs with request ids (`x-request-id` propagated) and job ids. Credentials and bodies are redacted. Prometheus `/metrics` (bearer token) covers HTTP latency, job outcomes and duration, queue depth (including failed), AI latency, AI cost and provider failures. Sentry is used when a DSN is configured. `/health` is liveness; `/health/ready` checks Postgres and Redis.

## Time

Nigeria only in V1. Timestamps are stored as UTC and Africa/Lagos is a fixed UTC+1 (no DST), used for month and year boundaries (`lagos-time.ts`). The web app converts Lagos wall-clock time to UTC when scheduling.

## Configuration

Every environment variable is validated against one Zod schema by Nest's `ConfigModule` (`validationSchema`) when the app boots; an invalid or missing value stops the process before it takes traffic. Adapters receive a typed settings object built from `ConfigService`, where required values are read with `getOrThrow`. Config values are never logged.

## Resilience rules

- **Timeouts.** Every outbound call has an explicit timeout that actually aborts the work: HTTP calls use `AbortSignal.timeout()`, Postgres has a server-side `statement_timeout`, Redis has connect and command timeouts, the S3 client has connection and inactivity timeouts, and ffmpeg is killed after its limit.
- **One retry layer per call.** Background jobs are retried by BullMQ with exponential backoff; interactive requests are retried by the client. Provider clients (OpenAI, S3 SDK, Paystack, Resend) make exactly one attempt, so attempts never multiply.
- **Abort signals reach the I/O.** Every job attempt gets an abort signal that fires when its per-queue time limit passes (transcription 25 min, analysis and generation 5 min, …) or when shutdown runs past its grace period. It is passed down to the storage download, ffmpeg/ffprobe (the child process is killed), OpenAI calls and embeddings, so a stopped attempt does not keep running in the background.
- **Fencing for scheduled work.** Each recurring run records its lock's fencing token in Redis and checks it before every batch of writes; a run that paused past its lease and was superseded stops before writing.
- **Fallbacks.** If the embedding provider is down, semantic search and Ask fall back to keyword matching over the same church-scoped segments. If answer generation fails, Ask returns the closest passages as sources with a plain "couldn't write a summary" message, never an invented answer.
- **Circuit breaker and concurrency cap.** OpenAI (text, embeddings, transcription), Paystack and Resend calls go through a `DependencyGuard` inside the adapter. After repeated provider failures it fails fast for a cooling-off period, and it caps concurrent calls per process. A tripped guard is a 503 with `Retry-After` on the API and a normal retry for a job.
- **Idempotent writes.** `Idempotency-Key` is required on checkout, the billing portal and forgot-password, and optional elsewhere. Same key and body replays the stored response; a different body is a 422; a duplicate still in flight is a 409 with `Retry-After`; responses of 500 and above are not stored. Records live in Redis and are scoped per user.

## Scheduled work

Recurring work (publishing dispatch, recovery sweeps, purges) is scheduled once for the whole cluster with BullMQ job schedulers and runs under a Redis lock from `@nestjs/locks`: one instance runs a tick, and a tick is skipped while the previous run is still going. Each handler processes current state (everything due, everything stuck), never a time window, so missed ticks need no replay. The lock's abort signal and fencing token are available to handlers through the job context.

## HTTP pipeline

Security headers and CSRF protection come from Nest 12 (`app.useSecurityHeaders()`, `app.enableCsrfProtection()` with the web origins as trusted origins). The exception filter, guards and interceptors are registered as `APP_FILTER` / `APP_GUARD` / `APP_INTERCEPTOR` providers, so tests run the same pipeline as production. The filter extends `BaseExceptionFilter`: it maps the errors it knows to the error envelope and delegates anything else, which stays an opaque, logged 500. The JSON body limit is the 100 KB default; only `POST /sermons` (pasted transcripts) has a larger limit.

## Brand Studio and media pipeline (`brand` module)

- `BrandProfile` + `BrandVoice` per church (`GET/PUT /brand-studio`), seeded from the church record until first saved. Logos are presigned uploads (PNG/JPEG/WebP, ≤ 5 MB, never SVG) recorded as `media_assets`; a logo becomes `READY` only when attached and the object is confirmed in storage. Unattached uploads are purged after a day.
- Templates are deterministic code (`brand/domain/templates.ts`, `template-svg.ts`): text is laid out and escaped by us, never drawn by a generative model. `POST /brand-studio/preview` returns the same SVG the worker rasterises, so previews cost nothing in the API process.
- `POST /content/:id/render` (image, carousel, video) records `PENDING` assets with an exact render spec and queues `brand-render` or `video-render`. Workers render (sharp for cards, ffmpeg for 9:16 captioned clips with logo and thumbnail), upload to `churches/{churchId}/sermons/{sermonId}/generated/{images|carousels|reels|thumbnails}/`, and mark assets `READY` with size, dimensions and duration. Renders are idempotent (fixed keys, `PENDING`-only transitions); stuck renders fail after an hour.
- Captions use the transcript's word timings (OpenAI `timestamp_granularities=word`, stored per segment as `[text, startMs, endMs]` tuples). Sermons transcribed before word timings existed, documents and pasted text fall back to timings estimated from each word's share of its segment.

## Direct social publishing (`social` module)

- Providers sit behind `SocialPublishingPort` (`social/application/ports/out/social-publishing.port.ts`); adapters live in `social/infrastructure/providers/{meta,tiktok,youtube,x,linkedin}` and all HTTP goes through `SocialHttpClient` (per-attempt timeout, per-provider circuit breaker and bulkhead, per-operation metrics, provider request ids). `SocialProviderRegistry` maps platforms to adapters (Facebook and Instagram → Meta). Capabilities (`GET /social/capabilities`) come from the adapters, never from the frontend.
- OAuth: random single-use state (hash stored in Redis for 10 minutes) bound to church + user, PKCE verifier kept server-side, callback requires the same session. Grants with several Pages/organisations go through a selection step whose tokens are sealed in Redis and consumed once. Tokens are AES-256-GCM sealed with `SOCIAL_TOKEN_ENCRYPTION_KEY`, bound to church + connection as associated data, with key rotation support; they are decrypted only by `ConnectionAccessService` right before a provider call. Refreshes are serialised per connection (rotating refresh tokens). `token-maintenance` refreshes ahead of expiry and marks lapsed connections `expired`.
- Posts have one `social_publication` per target, each its own `social-publish` job, so one provider failing never blocks another; the parent status is derived (`partially_published` is first-class) under a per-post lock.
- Exactly-once: a publication is claimed `queued → publishing` with a compare-and-set before the provider is called. Adapters mark the call that makes content public as *decisive*: a timeout or 5xx on it is "outcome unknown", never retried automatically, and `POST /social/posts/:id/retry` needs `confirmNotPublished` for it. Definite, retryable failures (rate limits, provider outages before the decisive call) go back to `queued` and the queue retries with backoff; auth failures mark the connection `expired`. Async provider processing (Instagram containers, reels, TikTok, X video, LinkedIn video) returns `processing` and is followed by delayed `social-status` checks, never by holding a request open.
- A minute dispatcher (locked, one instance) claims due scheduled targets with `FOR UPDATE SKIP LOCKED`, re-queues targets lost between claim and enqueue, re-queues lost status checks, and fails targets whose worker died mid-call (outcome unknown).
- Media handed to providers is generated media only, as signed URLs (or the optional public delivery host for `…/generated/` keys). Original sermon uploads are never exposed.
- `POST /social/posts/:id/publish` and `/retry` require `Idempotency-Key`. Every connect, disconnect, schedule, publish and failure is written to `social_audit_logs`.
- Metrics: `social_provider_calls_total` (per provider/operation, which doubles as X billable-operation tracking), `social_publications_total`, `social_publication_latency_seconds`, `social_token_refresh_total`, `media_render_duration_seconds`; storage per church is metered as `STORAGE_BYTES` usage events.

## Plans and entitlements

Plan rules live in one table (`billing/domain/plans.ts`): sermons per period plus Reel features (`reelsPerPeriod`, `reelHooks`, `animatedCaptions`, `priorityProcessing`, `sourceRetentionDays`). `EntitlementService` evaluates them and is exposed to other modules as the shared `PLAN_ENTITLEMENTS` port; no other code checks a plan id. `GET /billing/subscription` returns the features so the web app can show or hide Reel tools, and `GET /billing/usage` reports `reelsUsed` / `reelsLimit`.

| Plan | Sermons | Reels / period | Hooks, animated captions | Priority renders | Source kept |
|---|---|---|---|---|---|
| free | 2 | 0 | no | no | 3 days |
| starter | 6 | 0 | no | no | 3 days |
| growth | 15 | 8 | yes | no | 14 days |
| ministry | 40 | 24 | yes | yes | 30 days |

## Source retention

The original upload's expiry is fixed at upload time (`sermon_assets.expires_at` = now + the plan's `sourceRetentionDays`). An hourly maintenance job deletes expired originals from storage and stamps `deleted_at`; it skips sermons still processing. Everything derived from the original is kept. After expiry, new clips and Reels from that sermon return `SOURCE_EXPIRED`; existing renders, transcripts, intelligence and candidates are unaffected.

## Reels (`reels` module)

Principle: the Reel is the pastor's real video and voice. AI picks moments and writes on-screen hook copy; it never generates or alters what the pastor says.

- **Candidates.** When a media sermon becomes READY the pipeline queues `reel-candidates` (job contract in `shared/application/reel-jobs.ts`, so neither module imports the other). The transcript is split into timed sentences (word timings where available); one structured model call proposes moments by sentence index with 1–10 scores (standalone, impact, quotability, context independence). `selectReelCandidates` then does the work that must be trustworthy: snaps boundaries to whole sentences with a short lead-in and tail, stretches or trims by whole sentences to the allowed length (`MEDIA_REEL_MIN/MAX_SECONDS`), takes the transcript text from the sermon itself (never from the model), ranks by weighted score and drops overlaps, keeping 5–10. Automatic runs skip sermons that already have candidates; `POST /sermons/:id/reel-candidates` regenerates (per-church AI budget).
- **Drafts and hooks.** `POST /reels` from a candidate or a custom window (validated against the sermon). `POST /reels/:id/hooks` returns three hook options in the church's voice (avoid-phrases, preferred terms, emoji policy), with guardrails in code: no quotation marks (a hook is never presented as the pastor's words), length limit, avoided phrases dropped, duplicates removed. Hook generation never renders. `PATCH /reels/:id` edits title, hook, caption style/position and window; edits are refused while rendering and, on a rendered Reel, mark it `editedSinceRender` and unapproved.
- **Render request.** `POST /reels/:id/render` is naturally idempotent (an unchanged rendered Reel or one already rendering is returned as is). Under a per-church lock it checks the plan (Reels included, animated captions and hooks allowed) and the allowance (`reelsUsed + renders in flight < reelsPerPeriod`), moves the Reel to `QUEUED` with a new `renderAttempt`, and queues `reel-render` (job id per attempt; Ministry jobs get queue priority). Failing to enqueue marks the Reel FAILED instead of leaving it queued.
- **Render worker.** States `QUEUED → PREPARING → CROPPING → ADDING_HOOK → ADDING_CAPTIONS → BRANDING → ENCODING → COMPLETED | FAILED`, each written with a compare-and-set on `renderAttempt`, so a deleted, re-queued or finished Reel stops a stale worker (`GET /reels/:id` shows status and progress). The worker downloads the original, probes it (rotation aware), runs the `SpeakerTrackingPort` for landscape sources and plans a smooth crop (`planCropPath`: hold gaps, median filter, dead zone, pan-speed limit, few keyframes), builds caption cues from word timings, and calls the `ReelRendererPort`. The FFmpeg adapter does one encode: exact cut, moving 9:16 crop (or blurred-fill fit for vertical sources), real audio cleaned only (high-pass, light noise reduction, gentle speech compression, -14 LUFS), silent branded outro, libass overlay (hook animation per style, IMPACT/QUESTION/MINIMAL/HIGHLIGHT/TYPEWRITER; captions CLEAN/WORD_HIGHLIGHT/POP/DYNAMIC; speaker/church label; outro text), logo small during the moment and large on the outro. Output is stored as Brand Studio media assets (VIDEO + THUMBNAIL) with ids derived from (Reel, attempt), so retries overwrite instead of duplicating and social posts can attach them like any generated media (`contentId` is optional on posts for this). A render superseded mid-encode deletes its own output. Usage: `REEL_RENDERED` (counted on completion), `RENDER_SECOND`, `STORAGE_BYTES`, all with dedupe keys. Stuck renders are failed after an hour by a recurring sweep.
- **Video settings.** `brand_profiles.video_settings` (hook style, caption style and position, logo position, speaker/church label switches, outro) set each new Reel's defaults; a Reel overrides hook and caption choices.
- **Not built (V1 exclusions):** avatars, voice cloning, synthetic or text-to-video sermons, B-roll, timeline editing, YouTube downloading.

## Social publishing additions

- One `SOCIAL_PUBLICATION` usage event per publication made public (dedupe per publication).
- Publication views carry `requiresReauth` (failed with `AUTH_EXPIRED`): the account must be reconnected before a retry. The stored status stays `failed`.

