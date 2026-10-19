# Abyde Sermon Backend Build Specification for Codex

## 1. Objective

Build the production backend for **Abyde Sermon**, an AI-powered SaaS that transforms church sermons into weekly ministry content.

This is a **standalone backend repository**.

Repository name:

```text
abyde-sermon-api
```

Do not create a monorepo.

The backend should initially be a **modular monolith** with background workers that can run as separate processes/containers from the API while sharing the same codebase.

Core processing loop:

```text
Upload Sermon
      ↓
Create Processing Job
      ↓
Transcribe
      ↓
Clean + Segment Transcript
      ↓
Analyze Sermon
      ↓
Verify Scripture References
      ↓
Create Embeddings
      ↓
Sermon Ready
      ↓
Generate My Week
      ↓
Generate Content Types Independently
      ↓
User Reviews / Approves
      ↓
Schedule / Publish
```

---

## 2. Technology

Use:

- NestJS
- TypeScript strict mode
- PostgreSQL
- Prisma ORM
- pgvector
- Redis
- BullMQ
- S3-compatible object storage (AWS S3 or Cloudflare R2 compatible abstraction)
- OpenAPI / Swagger
- Zod or class-validator for runtime input validation
- Jest
- Docker
- structured logging

The AI architecture must be provider-agnostic.

Do not tightly couple business logic to OpenAI or any other AI vendor.

---

## 3. Account Model

Abyde Sermon V1 intentionally supports:

```text
1 User -> 1 Church -> 1 Workspace
```

Do NOT build:

- team invitations
- organization members
- organization switching
- multiple churches per user
- RBAC
- reviewer accounts
- approval assignments
- team management

A user signs up once and creates exactly one church during onboarding.

**Market (V1): Nigeria only.** There are no `country` or `timezone` fields anywhere in the model or API. Currency, locale and scheduling defaults are Nigerian (`Africa/Lagos`).

However, all ministry-owned records must still carry `churchId` so the data model can evolve later without redesigning core resources.

---

## 4. Backend Architecture

Suggested structure:

```text
src/
├── modules/
│   ├── auth/
│   ├── users/
│   ├── churches/
│   ├── uploads/
│   ├── sermons/
│   ├── transcripts/
│   ├── ai/
│   ├── scriptures/
│   ├── embeddings/
│   ├── content/
│   ├── calendar/
│   ├── library/
│   ├── usage/
│   ├── billing/
│   ├── integrations/
│   ├── publishing/
│   └── analytics/
│
├── jobs/
│   ├── queues/
│   ├── processors/
│   └── jobs.module.ts
│
├── providers/
│   ├── ai/
│   ├── storage/
│   ├── transcription/
│   ├── payments/
│   ├── email/
│   ├── social/
│   └── video/
│
├── database/
├── common/
│   ├── decorators/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   ├── pipes/
│   ├── types/
│   └── utils/
├── config/
└── main.ts
```

Avoid creating microservices prematurely.

---

## 5. Core Domain Model

At minimum plan for:

```text
User
Church
Sermon
SermonAsset
Transcript
TranscriptSegment
SermonIntelligence
ScriptureReference
SermonEmbedding
ContentItem
ContentVersion
CalendarItem
ProcessingJob
UsageEvent
Subscription
Integration
PublishAttempt
AIUsageLog
```

Use UUID/CUID-style opaque identifiers rather than sequential public IDs.

---

## 6. User

Suggested fields:

```text
id
fullName
email
passwordHash
emailVerifiedAt
onboardingCompleted
createdAt
updatedAt
```

Email must be unique and normalized.

Never return `passwordHash` through API serializers.

---

## 7. Church

One-to-one with the V1 user.

Suggested fields:

```text
id
userId
name
slug
ownerRole
logoUrl
denomination
website
description
preferredBibleTranslation
primaryColor
secondaryColor
devotionalTone
socialTone
audienceDescription
wordsToAvoid
additionalAIContext
createdAt
updatedAt
```

Enforce one church per user at the database/application level.

---

## 8. Authentication

Implement:

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
GET  /api/v1/auth/me
```

Use a secure production-ready authentication strategy.

Requirements:

- strong password hashing
- refresh/session strategy appropriate for web clients
- token/session revocation
- rate-limit auth endpoints
- normalize emails
- generic login/reset errors where needed to reduce account enumeration
- never log passwords or raw auth tokens

`GET /auth/me` should return enough information for the frontend to determine:

```text
authenticated
onboardingCompleted
church
```

---

## 9. Church Onboarding

Endpoints:

```http
POST  /api/v1/church
GET   /api/v1/church
PATCH /api/v1/church
POST  /api/v1/church/logo/presign
```

Rules:

- authenticated user only
- user can create only one church
- `churchId` is derived from authenticated ownership, never trusted from arbitrary frontend input
- completing required church setup updates onboarding state

Do not create organization/member/invitation tables.

---

## 10. File Storage

Create a provider abstraction:

```ts
interface StorageProvider {
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  createDownloadUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
}
```

Large sermon files must upload directly from the browser to object storage using signed URLs.

Do NOT stream large MP4 files through the NestJS API.

Requirements:

- allowed MIME types
- extension/MIME validation
- file-size limits
- unique storage keys
- church-scoped paths
- short-lived signed URLs
- private buckets by default

Plan for malware scanning or asynchronous file validation before broad production use.

---

## 11. Sermon Model

Suggested fields:

```text
id
churchId
title
speaker
sermonDate
series
mainScripture
status
processingStage
summary
mainTheme
createdAt
updatedAt
```

Statuses:

```text
UPLOADING
UPLOADED
QUEUED
TRANSCRIBING
ANALYZING
INDEXING
READY
FAILED
ARCHIVED
```

Endpoints:

```http
POST   /api/v1/sermons
GET    /api/v1/sermons
GET    /api/v1/sermons/:id
PATCH  /api/v1/sermons/:id
DELETE /api/v1/sermons/:id
GET    /api/v1/sermons/:id/status
```

Every query must be scoped to the authenticated user's church.

---

## 12. Upload Flow

Recommended sequence:

```text
Frontend
   ↓
POST /uploads/presign
   ↓
API validates requested media type/size
   ↓
API returns signed object-storage URL
   ↓
Browser uploads directly to storage
   ↓
Frontend POST /sermons with uploaded object key
   ↓
API verifies ownership/object
   ↓
Create Sermon + Processing Job
   ↓
Return 202 Accepted
```

Do not trust arbitrary storage object keys supplied by the browser without validation.

---

## 13. Asynchronous Processing

A 60-minute sermon must never hold an HTTP request open while AI processing occurs.

Use Redis + BullMQ.

Queues should include:

```text
sermon-processing
transcription
sermon-analysis
embeddings
content-generation
publishing
image-generation (V2)
video-generation (V2)
```

Job states:

```text
QUEUED
PROCESSING
RETRYING
COMPLETED
FAILED
```

Use sensible retry/backoff policies.

Jobs must be idempotent where practical.

Store enough state to recover from worker restarts.

---

## 14. Worker Runtime

The same repository should support separate commands/processes such as:

```text
npm run start:api
npm run start:worker
```

Production should be able to deploy:

```text
API container x N
Worker container x N
```

independently.

Do not make the web request process responsible for heavy transcription/video processing.

---

## 15. Transcription

Create a provider interface:

```ts
interface TranscriptionProvider {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
```

Store the normalized transcript plus timestamped segments.

Transcript:

```text
id
churchId
sermonId
fullText
language
provider
createdAt
```

TranscriptSegment:

```text
id
churchId
sermonId
transcriptId
startTimeMs
endTimeMs
text
speakerLabel
sequence
```

Timestamped segments are required because generated content should eventually be traceable back to sermon evidence.

---

## 16. AI Provider Abstraction

Create application-level interfaces rather than scattering SDK calls through services.

Example:

```ts
interface AIProvider {
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
  embed(input: EmbedInput): Promise<EmbeddingResult>;
}
```

Then application workflows:

```ts
interface SermonAIService {
  analyzeSermon(...): Promise<SermonIntelligence>;
  generateContent(...): Promise<GeneratedContent>;
  answerMinistryQuestion(...): Promise<GroundedAnswer>;
}
```

Provider-specific code belongs under `providers/ai`.

Business logic belongs under application/domain services.

---

## 17. Sermon Intelligence

Convert every sermon into a structured representation.

Example shape:

```json
{
  "title": "Trusting God in Difficult Seasons",
  "summary": "...",
  "mainTheme": "Trusting God during uncertainty",
  "secondaryThemes": [],
  "keyPoints": [],
  "scriptures": [],
  "quotes": [],
  "stories": [],
  "applications": [],
  "prayers": [],
  "questions": [],
  "audienceTakeaways": []
}
```

Validate structured AI output at runtime before persistence.

Important extracted objects should contain evidence references where possible:

```text
sourceSegmentId
startTimeMs
endTimeMs
confidence/verification metadata where useful
```

---

## 18. AI Guardrails

Enforce the following at workflow/prompt/application level:

1. Do not invent Bible verses.
2. Do not create fake direct pastor quotations.
3. Do not attribute generated theological wording to the pastor.
4. Preserve source sermon references when practical.
5. Clearly distinguish extracted quotes from generated prose.
6. Important analysis uses structured validated output.
7. Generated content is initially a draft.
8. Maintain content version history.
9. Do not use another church's sermons as generation context.
10. Log model/provider/version metadata for traceability without unnecessarily logging sensitive content.

---

## 19. Scripture Verification

Do not rely exclusively on the generative model for reference validity.

Create a scripture normalization/verification service.

Pipeline:

```text
Detected reference
      ↓
Normalize book name
      ↓
Validate chapter/verse bounds
      ↓
Persist verified reference
```

Suggested model:

```text
id
churchId
sermonId
book
chapter
verseStart
verseEnd
translation
verified
sourceSegmentId
```

If actual verse text is supplied through an external Bible provider, comply with that provider/translation's licensing requirements.

---

## 20. Embeddings / pgvector

Enable pgvector.

Chunk sermon transcripts into meaningful segments.

Store:

```text
id
churchId
sermonId
transcriptSegmentId
content
embedding
metadata
createdAt
```

All vector queries MUST filter by `churchId` before/while ranking as supported by the implementation.

Never allow cross-church retrieval.

---

## 21. Semantic Search

Endpoints:

```http
POST /api/v1/library/search
POST /api/v1/library/semantic-search
```

Support searching by:

- title
- speaker
- scripture
- theme
- series
- tags
- semantic meaning

Return source metadata needed by the frontend.

---

## 22. Generate My Week

Endpoint:

```http
POST /api/v1/sermons/:id/generate-week
```

Example request:

```json
{
  "contentTypes": [
    "DEVOTIONAL",
    "SOCIAL_POST",
    "PRAYER",
    "BIBLE_STUDY",
    "EMAIL",
    "WHATSAPP",
    "QUOTE",
    "VIDEO_IDEA"
  ]
}
```

Return `202 Accepted` and generation job/group information.

Do NOT generate the entire week in one giant model call.

Create separate jobs by content type so failures can be retried independently.

Target outputs:

```text
7 devotionals
7 social posts
5 prayer points/messages
1 Bible study/discussion guide
1 email newsletter
5 WhatsApp messages
quote extraction
sermon summary
scripture references
3-5 short-video recommendations
```

---

## 23. Content Model

Use a shared content table rather than a table per content type.

Suggested fields:

```text
id
churchId
sermonId
type
title
body
platform
status
scheduledAt
publishedAt
sourceMetadata
currentVersion
createdAt
updatedAt
```

Types:

```text
DEVOTIONAL
SOCIAL_POST
PRAYER
BIBLE_STUDY
EMAIL
WHATSAPP
QUOTE
VIDEO_IDEA
```

V1 statuses:

```text
DRAFT
APPROVED
SCHEDULED
PUBLISHED
FAILED
ARCHIVED
```

Do NOT implement team review states in V1.

---

## 24. Content Endpoints

```http
GET    /api/v1/content
GET    /api/v1/content/:id
PATCH  /api/v1/content/:id
POST   /api/v1/content/:id/approve
POST   /api/v1/content/:id/regenerate
POST   /api/v1/content/:id/rewrite
DELETE /api/v1/content/:id
```

Rewrite operations can support actions such as:

```text
SHORTEN
EXPAND
WARMER
CONVERSATIONAL
ALTERNATIVE
```

Every generated/rewrite version must preserve traceability.

---

## 25. Content Versioning

Create `ContentVersion`.

Store:

```text
id
contentItemId
version
title
body
source
aiProvider
aiModel
createdAt
```

`source` examples:

```text
AI_GENERATED
AI_REWRITE
USER_EDIT
```

Never destroy the previous version when regenerating.

---

## 26. Source Metadata

Generated content should be able to point back to sermon evidence.

Store references such as:

```text
sermonId
transcriptSegmentIds
scriptureReferenceIds
startTimeMs
endTimeMs
```

The frontend should be able to show:

```text
Source sermon
Relevant section
Timestamp
Referenced scripture
```

---

## 27. Calendar

CalendarItem fields:

```text
id
churchId
contentItemId
scheduledAt
status
createdAt
updatedAt
```

Endpoints:

```http
GET    /api/v1/calendar
POST   /api/v1/calendar
PATCH  /api/v1/calendar/:id
DELETE /api/v1/calendar/:id
```

V1 launches in Nigeria only. All scheduling is interpreted in `Africa/Lagos` (WAT, UTC+1, no daylight saving). Store canonical UTC timestamps; there are no per-church country or timezone fields.

---

## 28. Ask Your Ministry

Endpoint:

```http
POST /api/v1/ask
```

Pipeline:

```text
Question
  ↓
Create query embedding
  ↓
Retrieve church-scoped sermon chunks
  ↓
Rank/retrieve relevant evidence
  ↓
Generate grounded answer
  ↓
Return answer + sources
```

Response should include citations/source objects:

```json
{
  "answer": "...",
  "sources": [
    {
      "sermonId": "...",
      "sermonTitle": "Walking By Faith",
      "segmentId": "...",
      "startTimeMs": 854000,
      "endTimeMs": 1000000,
      "excerpt": "..."
    }
  ]
}
```

The model must be instructed to say when the retrieved archive does not provide enough evidence.

Do not let it pretend the church taught something unsupported by the retrieved sermons.

---

## 29. Usage Tracking

Create `UsageEvent`.

Track internal units such as:

```text
TRANSCRIPTION_MINUTE
TEXT_GENERATION
EMBEDDING
IMAGE_GENERATION
VIDEO_GENERATION
STORAGE_BYTES
```

Also maintain customer-friendly aggregates such as:

```text
sermons processed this billing period
content pieces generated
```

Do not expose raw provider token economics as the primary customer-facing usage unit.

---

## 30. AI Cost Logging

Create an internal AI usage log with fields such as:

```text
id
churchId
sermonId
operation
provider
model
inputTokens
outputTokens
estimatedCost
latencyMs
status
createdAt
```

This is essential for understanding unit economics.

Do not log entire prompts/responses by default in production if they may contain sensitive ministry content.

---

## 31. Billing

Create provider abstraction where practical.

Core models:

```text
Subscription
BillingCustomer
UsageAllowance
```

Endpoints:

```http
GET  /api/v1/billing/subscription
GET  /api/v1/billing/usage
POST /api/v1/billing/checkout
POST /api/v1/billing/portal
POST /api/v1/webhooks/billing/:provider
```

Webhook requirements:

- verify signatures
- idempotency
- replay-safe processing
- never trust frontend payment status

Plans should be enforceable using customer-friendly allowances such as sermons/month.

---

## 32. Publishing Abstraction

Do not tightly couple ContentService to Meta/WhatsApp/etc.

Create:

```ts
interface PublishingProvider {
  publish(input: PublishInput): Promise<PublishResult>;
  getStatus?(externalId: string): Promise<PublishStatus>;
  getMetrics?(externalId: string): Promise<PublishMetrics>;
}
```

Potential adapters:

```text
MetaProvider
WhatsAppProvider
EmailProvider
YouTubeProvider
```

Publishing should happen through background jobs.

---

## 33. Integrations

Store encrypted provider credentials/tokens server-side.

Never return secrets to the browser.

Suggested fields:

```text
id
churchId
provider
status
encryptedCredentials
externalAccountId
expiresAt
createdAt
updatedAt
```

Support secure OAuth state verification where applicable.

---

## 34. Publishing Flow

```text
Approved Content
      ↓
Schedule
      ↓
Calendar due time
      ↓
Publishing queue
      ↓
Provider adapter
      ↓
Success / Failure
      ↓
Update content + PublishAttempt
      ↓
```

Retries must avoid duplicate publishing.

Use provider idempotency capabilities where available and internal deduplication otherwise.

---

## 35. Analytics

Initial internal/product metrics:

```text
sermonsUploaded
sermonsProcessed
contentGenerated
contentApproved
contentScheduled
contentPublished
processingFailures
generationFailures
```

When external publishing providers expose metrics, normalize them behind the analytics layer.

Do not fabricate missing metrics.

---

## 36. V2 Graphics

Do not block MVP on this.

Create future abstraction:

```ts
interface CreativeProvider {
  generateQuoteCard(...): Promise<CreativeAsset>;
  generateSocialGraphic(...): Promise<CreativeAsset>;
  generateThumbnail(...): Promise<CreativeAsset>;
}
```

Brand inputs can include:

```text
logo
primary color
secondary color
font preferences
templates
approved imagery
```

---

## 37. V2 AI Video / Higgsfield

Keep video generation behind a provider interface.

Example:

```ts
interface VideoProvider {
  createVideo(input: CreateVideoInput): Promise<VideoJob>;
  getJob(jobId: string): Promise<VideoJobStatus>;
}
```

Do not put Higgsfield-specific assumptions into core content logic.

Future pastor likeness/avatar functionality must include explicit consent/authorization, revocation/deletion controls, secure source-media storage, and appropriate generated-media handling.

---

## 38. Security Requirements

Before production, implement and test:

- secure password hashing
- auth rate limiting
- API rate limiting
- input validation
- SQL injection resistance through ORM/parameterization
- output serialization
- church ownership guards
- signed private storage URLs
- upload MIME/size validation
- webhook signature verification
- secrets management
- secure headers
- CORS allowlist
- audit/security logging where appropriate
- dependency scanning
- production error sanitization

Most important invariant:

```text
A user can access ONLY data belonging to their own church.
```

Never trust `churchId` from a request body as authorization.

Derive ownership from the authenticated user and verify every resource.

---

## 39. Cross-Church Isolation Tests

Even though V1 has one church per account, create at least two test accounts/churches in integration tests.

Verify:

```text
Church A cannot fetch Church B sermon.
Church A cannot modify Church B sermon.
Church A cannot fetch Church B content.
Church A cannot search Church B embeddings.
Church A cannot access Church B storage asset.
Church A cannot access Church B calendar item.
Church A cannot access Church B integration.
```

These are mandatory tests.

---

## 40. Error Shape

Use one consistent API error envelope, for example:

```json
{
  "statusCode": 422,
  "code": "VALIDATION_ERROR",
  "message": "The request could not be processed.",
  "errors": {
    "title": ["Title is required"]
  },
  "requestId": "..."
}
```

Do not expose stack traces in production.

---

## 41. API Versioning

Prefix production API routes:

```text
/api/v1
```

Enable Swagger/OpenAPI for development/staging and secure/disable it appropriately in production according to deployment policy.

---

## 42. Pagination

Use consistent pagination for sermons, content, etc.

Example response:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 120,
    "totalPages": 6
  }
}
```

Enforce maximum page sizes.

---

## 43. Search

Debounced frontend search must map to safe backend queries.

Use indexed database fields for common filters.

Do not introduce N+1 queries in list endpoints.

Profile expensive sermon/library queries.

---

## 44. Database Indexing

Add indexes based on actual query patterns, including likely combinations such as:

```text
User.email
Church.userId
Sermon.churchId + sermonDate
Sermon.churchId + status
ContentItem.churchId + status
ContentItem.churchId + sermonId
CalendarItem.churchId + scheduledAt
UsageEvent.churchId + createdAt
```

Use appropriate vector indexes after validating pgvector workload/scale.

---

## 45. Observability

Implement:

- structured logs
- request IDs
- job IDs
- error monitoring integration
- API latency metrics
- queue health
- failed-job visibility
- AI latency
- AI cost
- provider failure rates

Logs should make it possible to trace:

```text
request -> sermon -> job -> AI operation -> generated content
```

without unnecessarily storing sensitive content.

---

## 46. Health Checks

Provide:

```http
GET /health
GET /health/ready
```

Readiness should account for required dependencies such as database and Redis.

Do not report ready when the application cannot serve normal traffic.

---

## 47. Testing

Use:

- unit tests
- integration tests
- API/e2e tests
- database tests
- queue tests
- ownership/isolation tests
- structured AI output validation tests
- webhook tests

Critical backend E2E:

```text
Register
-> Create Church
-> Request Upload URL
-> Create Sermon
-> Queue Processing
-> Complete Transcription (provider mocked)
-> Analyze Sermon (provider mocked)
-> Create Embeddings
-> Mark Sermon READY
-> Generate Week
-> Persist Content
-> Edit Content
-> Approve
-> Schedule
```

External providers should be mocked in CI.

---

## 48. Local Development

Provide Docker Compose for dependencies:

```text
PostgreSQL + pgvector
Redis
```

The API itself may run locally through npm/pnpm for fast development.

Document:

```text
install
.env setup
database migration
database seed
start API
start worker
run tests
```

Create development seed data for one or two demo churches/sermons without including real personal data.

---

## 49. Production Deployment Model

Deploy frontend separately from this repository.

Backend topology:

```text
                 Load Balancer / Proxy
                         │
                   NestJS API
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   PostgreSQL          Redis         Object Storage
   + pgvector            │                 │
                         ▼                 │
                    BullMQ Queues          │
                         │                 │
                         ▼                 │
                       Workers ────────────┘
                         │
                External AI Providers
```

API and worker should use separate deployable process definitions/images or commands even if built from the same repository.

---

## 50. CI/CD

Pull requests:

```text
Install
-> Lint
-> Typecheck
-> Unit Tests
-> Integration Tests
-> Build
```

Main/staging deployment:

```text
Build image
-> Run safe database migration process
-> Deploy API
-> Deploy workers
-> Verify health
```

Production migrations must be backward-compatible with rolling deployments where possible.

Never allow Codex to manually mutate production data as part of normal feature implementation.

---

## 51. Environment Variables

Validate environment variables on startup.

Conceptual groups:

```text
APP_*
DATABASE_*
REDIS_*
AUTH_*
STORAGE_*
AI_*
TRANSCRIPTION_*
BILLING_*
EMAIL_*
PUBLISHING_*
OBSERVABILITY_*
```

Never commit production secrets.

Provide `.env.example` containing names and descriptions but no real credentials.

---

## 52. Codex Engineering Rules

For every implementation stage:

1. Inspect existing code first.
2. Do not implement unrelated future stages.
3. Preserve modular boundaries.
4. Keep TypeScript strict.
5. Do not use `any` to bypass typing problems.
6. Validate all external input.
7. Never trust client-supplied ownership identifiers.
8. Keep long-running work asynchronous.
9. Make queue jobs retry-safe/idempotent where practical.
10. Keep AI providers behind interfaces.
11. Keep storage providers behind interfaces.
12. Keep publishing providers behind interfaces.
13. Add database indexes intentionally.
14. Avoid N+1 queries.
15. Add meaningful tests.
16. Run lint, typecheck, tests and build before completion.
17. Document migrations and new environment variables.
18. Summarize architectural decisions after each stage.

Do not attempt the complete application in a single giant implementation pass.

---

## 53. Recommended Backend Build Stages

```text
B01 NestJS foundation + config + Docker dependencies
B02 PostgreSQL/Prisma schema foundation
B03 Authentication
B04 Church onboarding
B05 Storage abstraction + presigned uploads
B06 Sermon CRUD
B07 Redis/BullMQ + worker runtime
B08 Transcription pipeline
B09 Transcript segmentation
B10 AI provider abstraction
B11 Sermon intelligence
B12 Scripture verification
B13 pgvector + embeddings
B14 Semantic sermon search
B15 Generate My Week orchestration
B16 Devotional generation
B17 Social generation
B18 Prayer/Bible study generation
B19 Email/WhatsApp generation
B20 Quotes/video-idea generation
B21 Content CRUD + version history
B22 Calendar/scheduling
B23 Ask Your Ministry RAG
B24 Usage + AI cost metering
B25 Billing
B26 Publishing abstraction
B27 Social/email/WhatsApp integrations
B28 Analytics
B29 Security hardening
B30 Observability
B31 Full E2E/isolation testing
B32 CI/CD
B33 Staging deployment
B34 Production deployment
```

Complete, test, and verify each stage before moving to the next.

---

## 54. Definition of MVP Success

The backend MVP is successful when this workflow works reliably:

```text
User registers
      ↓
Creates one church
      ↓
Uploads a real sermon
      ↓
API returns quickly while workers process it
      ↓
Transcript is produced
      ↓
Sermon intelligence is produced
      ↓
Scriptures are normalized/verified
      ↓
Embeddings are stored
      ↓
Sermon becomes READY
      ↓
User requests Generate My Week
      ↓
Content jobs run independently
      ↓
Generated content is stored as drafts with source metadata
      ↓
User edits/approves content
      ↓
Content is scheduled on the calendar
      ↓
User can semantically search the sermon library
      ↓
User can ask a grounded question and receive sermon sources
```

Optimize engineering decisions around making this loop reliable before adding V2 graphics, AI avatars, or advanced automation.

---

# Addendum A — Web App Contract (Abyde Sermon)

> **For the backend agent.** This file accompanies `ABYDE_SERMON_BACKEND.md` (the main spec, already updated to include this addendum, renamed to Abyde Sermon, with notifications, country and timezone removed). Implement the main spec first; use this addendum for the exact API surface and JSON shapes the web app depends on. The web app has been aligned to this contract.

This addendum defines the API surface the **Abyde Sermon web app** (`abyde-sermon-web`) consumes. The main backend spec is the source of truth for architecture, models and existing endpoints; this addendum **adds** the endpoints and response shapes the UI needs. Where the addendum and earlier text conflict, **the addendum wins**.

All paths are relative to `/api/v1`. The web app reads `NEXT_PUBLIC_API_URL` (for example `https://api.example.com/api/v1`).

## A.0 Scope decisions (apply everywhere)

- **Market: Nigeria only (V1).** No `country` or `timezone` fields on any model, request or response. All scheduling is interpreted in `Africa/Lagos` (WAT, UTC+1, no DST). Timestamps are ISO-8601 UTC strings.
- **No notifications in V1.** No Notification model, endpoints, queue, events or per-user notification preferences.
- **Onboarding completes when the church is created.** `POST /church` sets `onboardingCompleted = true`. There is no separate "complete onboarding" call. Brand, AI preferences and logo are optional and edited later through `PATCH /church`.
- **Auth transport: bearer tokens.** Login and email verification return `accessToken`, `refreshToken` and `expiresIn`; the client sends `Authorization: Bearer <accessToken>` and calls `POST /auth/refresh` when it expires. `remember: true` on login extends the refresh token's lifetime. CORS is an allowlist without credentials. Provider OAuth redirects carry no token, so the web app finishes them with `POST /integrations/:provider/complete` and `POST /social/oauth/:provider/complete`.
- **Identifiers** are opaque strings. **Transcript times** are milliseconds (`startTimeMs`, `endTimeMs`).
- **Envelopes** (from the main spec, unchanged):
  - Lists: `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`
  - Errors: `{ "statusCode", "code", "message", "errors": { "field": ["message"] }, "requestId" }`
  - The web app shows `errors[field][0]` next to form fields and `message` as the general error.

## A.1 Auth

```http
POST /auth/register          body: { fullName, email, password }          -> 201 Me
POST /auth/login             body: { email, password, remember }          -> 200 Me
POST /auth/logout                                                         -> 204
GET  /auth/me                                                             -> 200 Me   (always 200; authenticated=false when signed out)
PATCH /auth/me               body: { fullName, email }                    -> 200 Me
POST /auth/change-password   body: { currentPassword, newPassword }       -> 204
POST /auth/forgot-password   body: { email }                              -> 204 (always, no enumeration)
POST /auth/reset-password    body: { token, password }                    -> 204
```

`Me`:

```json
{
  "authenticated": true,
  "user": { "id": "...", "fullName": "...", "email": "..." },
  "onboardingCompleted": true,
  "church": { "...Church" }
}
```

When signed out: `{ "authenticated": false, "user": null, "onboardingCompleted": false, "church": null }`.

Error codes the UI reacts to: `INVALID_CREDENTIALS` (401), `EMAIL_TAKEN` (409, with `errors.email`), `WRONG_PASSWORD` (422, with `errors.currentPassword`).

## A.2 Church

`Church` response (no country/timezone):

```json
{
  "id": "...",
  "name": "Grace Community Church",
  "slug": "grace-community-church",
  "ownerRole": "Lead Pastor",
  "denomination": "Non-denominational",
  "website": "https://example.org",
  "description": null,
  "logoUrl": "https://signed-or-public-url",
  "preferredBibleTranslation": "NIV",
  "primaryColor": "#B5502F",
  "secondaryColor": "#1B1A17",
  "devotionalTone": "Warm and pastoral",
  "socialTone": "Encouraging and concise",
  "audienceDescription": "",
  "wordsToAvoid": "",
  "additionalAIContext": ""
}
```

```http
POST  /church          body: { name, ownerRole, denomination?, website? }   -> 201 Me   (sets onboardingCompleted = true)
GET   /church                                                               -> 200 Church
PATCH /church          body: any subset of the editable fields above,
                       plus logoObjectKey?                                  -> 200 Church
POST  /church/logo/presign   body: { fileName, contentType, sizeBytes }     -> 200 PresignedUpload
```

- AI preferences (`preferredBibleTranslation`, `devotionalTone`, `socialTone`, `audienceDescription`, `wordsToAvoid`, `additionalAIContext`) and brand (`primaryColor`, `secondaryColor`, logo) are edited through `PATCH /church`. There are **no** separate `/church/ai-preferences` or `/church/brand` endpoints.
- `logoObjectKey` must be a key previously issued by `/church/logo/presign` for this church; the API verifies it exists before accepting.
- Colors: `#RRGGBB`.

## A.3 Uploads and sermons

```http
POST /uploads/presign        body: { fileName, contentType, sizeBytes, purpose: "SERMON_MEDIA" } -> 200 PresignedUpload
```

`PresignedUpload`:

```json
{
  "uploadUrl": "https://storage/...",
  "method": "PUT",
  "headers": { "Content-Type": "audio/mpeg" },
  "objectKey": "churches/<churchId>/sermons/<uuid>.mp3",
  "expiresAt": "2026-09-30T12:00:00Z"
}
```

The browser uploads directly to `uploadUrl` (XHR, for progress). Accepted types: MP3, WAV, MP4, PDF, DOCX, TXT; max 2 GB.

```http
POST   /sermons
  body: {
    title, speaker, sermonDate,          // required
    series?, mainScripture?, tags?: string[],
    objectKey?,                          // from /uploads/presign
    transcriptText?                      // pasted transcript; exactly one of objectKey | transcriptText
  }                                                       -> 202 { "id": "..." }

GET    /sermons?status=&q=&page=&pageSize=               -> 200 Paginated<Sermon>
GET    /sermons/:id                                      -> 200 Sermon
PATCH  /sermons/:id   body: { title?, speaker?, sermonDate?, series?, mainScripture?, tags? } -> 200 Sermon
DELETE /sermons/:id                                      -> 204
GET    /sermons/:id/status                               -> 200 SermonStatusInfo
POST   /sermons/:id/status/retry                         -> 202 SermonStatusInfo   (only when status = FAILED and canRetry)
GET    /sermons/:id/transcript                           -> 200 TranscriptSegment[]   (409 NOT_READY until READY)
GET    /sermons/:id/intelligence                         -> 200 SermonIntelligence    (409 NOT_READY until READY)
```

- `status` on the list accepts a **comma-separated** set, for example `status=UPLOADING,UPLOADED,QUEUED,TRANSCRIBING,ANALYZING,INDEXING` (the UI's "Processing" tab) or `status=READY` or `status=FAILED`. `ARCHIVED` is excluded unless requested. `q` matches title, speaker, series, main scripture.
- Sort: `sermonDate` descending by default.
- `DELETE` removes the sermon, its transcript, embeddings, derived content and storage objects (or soft-deletes and archives; the UI only needs the 204 and the row disappearing).

`Sermon`:

```json
{
  "id": "...",
  "title": "Walking By Faith",
  "speaker": "Pastor John",
  "sermonDate": "2026-09-27T09:00:00Z",
  "series": "Trust",
  "mainScripture": "2 Corinthians 5:7",
  "tags": ["faith"],
  "status": "READY",
  "processingStage": null,
  "summary": "...",
  "mainTheme": "Trusting God",
  "scriptures": ["2 Corinthians 5:7"],
  "themes": ["Faith", "Trust"],
  "contentCount": 12,
  "createdAt": "..."
}
```

`scriptures` are the verified references as display strings; `themes` come from sermon intelligence; `contentCount` is the number of non-archived content items for the sermon.

`SermonStatusInfo` (polled every ~2 s while processing):

```json
{
  "sermonId": "...",
  "status": "TRANSCRIBING",
  "processingStage": "TRANSCRIBE",
  "failedStage": null,
  "errorMessage": null,
  "canRetry": false
}
```

`processingStage` (the UI renders these as the 7-step stepper, in this order):

```text
UPLOAD        Upload complete
MEDIA         Preparing media
TRANSCRIBE    Transcribing sermon
UNDERSTAND    Understanding message
SCRIPTURES    Detecting scriptures
INTELLIGENCE  Building sermon intelligence
INDEX         Preparing search index
```

- While `status` is not `READY` or `FAILED`, `processingStage` is the stage currently running; stages before it are shown complete.
- When `status = FAILED`, `failedStage` is the stage that failed, `errorMessage` is a user-safe sentence, and `canRetry` says whether `POST /sermons/:id/status/retry` is allowed.
- When `status = READY`, `processingStage` is `null`.

`TranscriptSegment`:

```json
{ "id": "...", "sequence": 1, "startTimeMs": 0, "endTimeMs": 95000, "text": "...", "speakerLabel": null }
```

`SermonIntelligence` (items carry evidence where known):

```json
{
  "themes":       [{ "id": "...", "text": "...", "sourceSegmentId": "..." }],
  "keyPoints":    [],
  "quotes":       [],
  "stories":      [],
  "applications": [],
  "prayers":      [],
  "questions":    []
}
```

`themes` = main theme first, then secondary themes. `sourceSegmentId` is optional per item; when present it must reference a segment returned by the transcript endpoint for the same sermon.

## A.4 Generate My Week

```http
POST /sermons/:id/generate-week   body: { contentTypes: ContentType[] }   -> 202 GenerationGroup
GET  /sermons/:id/generations/:groupId                                    -> 200 GenerationGroup
```

- Only sermons with `status = READY` can generate (409 `NOT_READY` otherwise).
- `contentTypes` ⊆ `DEVOTIONAL, SOCIAL_POST, PRAYER, BIBLE_STUDY, EMAIL, WHATSAPP, QUOTE, VIDEO_IDEA`.
- Posting again with only previously failed types is the UI's "Retry failed" action; the backend must not duplicate already-completed types when a group is retried (idempotency per sermon + content type + group).

`GenerationGroup`:

```json
{
  "id": "...",
  "sermonId": "...",
  "jobs": [
    { "contentType": "DEVOTIONAL", "status": "COMPLETED", "errorMessage": null },
    { "contentType": "SOCIAL_POST", "status": "PROCESSING", "errorMessage": null },
    { "contentType": "QUOTE", "status": "FAILED", "errorMessage": "The model returned invalid output." }
  ],
  "done": false
}
```

`status` ∈ `QUEUED | PROCESSING | RETRYING | COMPLETED | FAILED`. `done` is true when every job is `COMPLETED` or `FAILED`. A failed type never changes the status of the others.

## A.5 Content

`ContentType`: `DEVOTIONAL | SOCIAL_POST | PRAYER | BIBLE_STUDY | EMAIL | WHATSAPP | QUOTE | VIDEO_IDEA`
`ContentStatus`: `DRAFT | APPROVED | SCHEDULED | PUBLISHED | FAILED | ARCHIVED`

```http
GET    /content?status=&type=&sermonId=&q=&scheduled=&page=&pageSize=   -> 200 Paginated<ContentItem>
GET    /content/:id                                                     -> 200 ContentItem
PATCH  /content/:id        body: { title?, body?, scripture? }          -> 200 ContentItem   (creates a USER_EDIT version)
POST   /content/:id/approve                                             -> 200 ContentItem
POST   /content/:id/rewrite    body: { action: "SHORTEN"|"EXPAND"|"WARMER"|"CONVERSATIONAL"|"ALTERNATIVE" } -> 200 ContentItem
POST   /content/:id/regenerate                                          -> 200 ContentItem
DELETE /content/:id                                                     -> 204
GET    /content/:id/versions                                            -> 200 ContentVersion[]   (newest first)
POST   /content/:id/versions/:version/restore                           -> 200 ContentItem   (creates a new USER_EDIT version copying the old one; never deletes history)
```

- `status` accepts one value. `scheduled=false` with `status=APPROVED` returns approved items that have no calendar item (used by the calendar's "Ready to schedule" panel). `q` searches title and body. Default sort: `updatedAt` descending.
- `rewrite` and `regenerate` **persist immediately**: they create an `AI_REWRITE` / `AI_GENERATED` version that becomes current, and return the updated item. The UI offers "Undo" by restoring the previous version.
- Editing or rewriting content with status `APPROVED` or `SCHEDULED` moves it back to `DRAFT` and **deletes its calendar item** (clearing `calendarItemId` and `scheduledAt`). Editing `FAILED` content also returns it to `DRAFT`. Approving again and re-scheduling is required. `PUBLISHED` and `ARCHIVED` items are read-only (422 `CONTENT_LOCKED`).
- `DELETE` is allowed for any status except items currently being published; it also removes the calendar item.

`ContentItem`:

```json
{
  "id": "...",
  "type": "DEVOTIONAL",
  "title": "Day 1: Walking without a map",
  "body": "...",
  "status": "DRAFT",
  "sermonId": "...",
  "sermonTitle": "Walking By Faith",
  "scripture": "2 Corinthians 5:7",
  "calendarItemId": null,
  "scheduledAt": null,
  "publishedAt": null,
  "currentVersion": 1,
  "updatedAt": "...",
  "source": {
    "sermonId": "...",
    "sermonTitle": "Walking By Faith",
    "segments": [
      { "id": "...", "startTimeMs": 95000, "endTimeMs": 190000, "text": "..." }
    ],
    "scriptures": ["2 Corinthians 5:7"],
    "verbatim": false
  }
}
```

- `source.segments` are resolved from `sourceMetadata.transcriptSegmentIds` (text included so the UI needs no extra request). `source.scriptures` are resolved display strings.
- `source.verbatim` is `true` only when the body is a direct extract from the transcript (for example a `QUOTE`). AI-written prose is always `false`. The UI uses this to label interpretation versus direct pastor words and **must never show AI prose as a pastor quote**.

`ContentVersion`:

```json
{
  "version": 3,
  "title": "...",
  "body": "...",
  "source": "AI_REWRITE",
  "aiProvider": "openai",
  "aiModel": "...",
  "createdAt": "..."
}
```

`source` ∈ `AI_GENERATED | AI_REWRITE | USER_EDIT`. `aiProvider` / `aiModel` are null for `USER_EDIT`.

## A.6 Calendar

```http
GET    /calendar?from=&to=                     -> 200 CalendarItem[]      (from/to are ISO instants, inclusive range)
POST   /calendar        body: { contentItemId, scheduledAt }   -> 201 CalendarItem
PATCH  /calendar/:id    body: { scheduledAt }                  -> 200 CalendarItem
DELETE /calendar/:id                                           -> 204     (unschedule; content returns to APPROVED)
```

`CalendarItem`:

```json
{
  "id": "...",
  "contentItemId": "...",
  "scheduledAt": "2026-10-01T06:00:00Z",
  "status": "SCHEDULED",
  "content": {
    "id": "...",
    "type": "DEVOTIONAL",
    "title": "...",
    "status": "SCHEDULED",
    "sermonId": "...",
    "sermonTitle": "..."
  }
}
```

Rules: only `APPROVED` (or already `SCHEDULED`) content can be scheduled (422 `CONTENT_NOT_APPROVED`); `scheduledAt` must be in the future (422 `PAST_DATE`, `errors.scheduledAt`). Creating a calendar item sets content `status = SCHEDULED`, `scheduledAt`, and `calendarItemId`. The web app sends times converted from Lagos wall-clock to UTC.

## A.7 Library and Ask

```http
POST /library/search            body: { speaker?, series?, scripture?, theme?, year?, tag?, page?, pageSize? } -> 200 Paginated<Sermon>
POST /library/semantic-search   body: { query, speaker?, series?, scripture?, theme?, year?, tag?, page?, pageSize? } -> 200 Paginated<Sermon>
GET  /library/facets                                          -> 200 LibraryFacets
POST /ask                       body: { question }            -> 200 AskAnswer
```

- The UI calls `semantic-search` when the search box has text and `search` when only filters are used. Only `READY` sermons are returned. Filters apply in both. Results use the `Sermon` shape.
- Every query is filtered by the caller's `churchId`.

`LibraryFacets`: `{ "speakers": [], "series": [], "scriptures": [], "themes": [], "years": ["2026"], "tags": [] }` (sorted; years descending).

`AskAnswer` (as in the main spec):

```json
{
  "answer": "...",
  "sources": [
    { "sermonId": "...", "sermonTitle": "...", "segmentId": "...", "startTimeMs": 854000, "endTimeMs": 1000000, "excerpt": "..." }
  ]
}
```

If the archive lacks evidence, return an `answer` saying so and `sources: []`.

## A.8 Dashboard and analytics

```http
GET /dashboard    -> 200 {
  "sermonsThisMonth": 3,
  "contentGenerated": 20,
  "scheduled": 4,
  "published": 7,
  "latestSermon": Sermon | null
}

GET /analytics    -> 200 {
  "sermonsUploaded": 5,
  "sermonsProcessed": 4,
  "contentGenerated": 20,
  "contentApproved": 6,
  "contentScheduled": 4,
  "contentPublished": 7,
  "processingFailures": 1,
  "generationFailures": 0,
  "publishingMetrics": null
}
```

`sermonsThisMonth` uses the calendar month in `Africa/Lagos`. `publishingMetrics` is `null` until a publishing provider returns real reach/engagement numbers; never fabricate values.

## A.9 Integrations

```http
GET    /integrations                          -> 200 Integration[]   (one row per supported provider, even when not connected)
POST   /integrations/:provider/connect        -> 200 { "authorizationUrl": "https://provider/oauth..." }
DELETE /integrations/:provider                -> 204
```

`Integration`: `{ "provider": "META" | "WHATSAPP" | "EMAIL" | "YOUTUBE", "status": "NOT_CONNECTED" | "CONNECTED" | "NEEDS_ATTENTION", "accountLabel": "Grace Community" | null }`.

The browser follows `authorizationUrl`; the OAuth callback is handled by the API, which stores encrypted credentials and redirects back to `/integrations`. Secrets are never returned.

## A.10 Billing

```http
GET  /billing/subscription   -> 200 { "planId": "growth", "planName": "Growth", "priceLabel": "₦25,000 / month", "status": "ACTIVE", "currentPeriodEnd": "2026-10-12T00:00:00Z" }
GET  /billing/usage          -> 200 { "sermonsUsed": 8, "sermonsLimit": 15, "contentGenerated": 142, "periodEnd": "2026-10-12T00:00:00Z" }
POST /billing/checkout       -> 200 { "url": "..." }
POST /billing/portal         -> 200 { "url": "..." }
```

Usage is customer-friendly (sermons and content pieces), never tokens. No invoice-history endpoint in V1; the UI hides billing history. `POST /billing/portal` is what "Upgrade or change plan" calls (use the provider's manage-subscription link where a hosted portal does not exist, for example Paystack).

## A.11 Removed / out of scope (do not build)

- Notifications (model, endpoints, queue, emails, events, preferences, `SUBSCRIPTION_LIMIT_REACHED` event).
- Country and timezone fields; per-church timezone logic.
- Separate onboarding-complete endpoint; `/church/ai-preferences`; `/church/brand`; `/auth/session`; `/auth/signup`.

## A.12 Endpoint checklist (web app → backend)

| Area | Endpoint | Status |
|---|---|---|
| Auth | register, login, logout, forgot, reset, me | in main spec |
| Auth | `PATCH /auth/me`, `POST /auth/change-password` | **added** |
| Church | `POST/GET/PATCH /church`, `/church/logo/presign` | in main spec (shapes defined here) |
| Uploads | `POST /uploads/presign` | in main spec (shape defined here) |
| Sermons | create, list, get, patch, delete, status | in main spec (shapes defined here) |
| Sermons | `POST /sermons/:id/status/retry`, `GET /sermons/:id/transcript`, `GET /sermons/:id/intelligence` | **added** |
| Generation | `POST /sermons/:id/generate-week` | in main spec |
| Generation | `GET /sermons/:id/generations/:groupId` | **added** |
| Content | list, get, patch, approve, rewrite, regenerate, delete | in main spec (filters/shapes defined here) |
| Content | `GET /content/:id/versions`, `POST /content/:id/versions/:version/restore` | **added** |
| Calendar | get, post, patch, delete | in main spec (shapes defined here) |
| Library | search, semantic-search, ask | in main spec (shapes defined here) |
| Library | `GET /library/facets` | **added** |
| Dashboard | `GET /dashboard` | **added** |
| Analytics | `GET /analytics` | **added route** (metrics in main spec) |
| Integrations | list, connect, disconnect | **added routes** |
| Billing | subscription, usage, checkout, portal | in main spec |

---

# Hexagonal Architecture (Ports & Adapters) — Mandatory Backend Architecture

Abyde Sermon API MUST use Hexagonal Architecture (Ports & Adapters) inside a modular monolith. Do not use a traditional NestJS controller → service → Prisma structure for core business logic.

## Core Dependency Rule

Dependencies always point inward:

```text
Infrastructure / Presentation
          ↓
     Application
          ↓
        Domain
```

The Domain layer MUST NOT depend on NestJS, Prisma, Redis, BullMQ, OpenAI, object storage SDKs, payment SDKs, social APIs, or any other framework/provider.

Never introduce dependencies such as:

```text
Domain → Prisma
Domain → NestJS
Domain → OpenAI
Domain → BullMQ
Domain → Redis
Domain → S3/R2
Domain → Paystack
```

External systems must be accessed through ports defined by the application/core and implemented by infrastructure adapters.

## Backend Structure

```text
abyde-sermon-api/
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── church/
│   │   ├── sermons/
│   │   ├── content/
│   │   ├── calendar/
│   │   ├── library/
│   │   ├── usage/
│   │   ├── billing/
│   │   ├── publishing/
│   │   ├── integrations/
│   │   └── analytics/
│   │
│   ├── shared/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   │
│   ├── app.module.ts
│   └── main.ts
├── prisma/
├── test/
├── Dockerfile
└── docker-compose.yml
```

Each business module should follow this structure:

```text
sermons/
├── domain/
│   ├── entities/
│   ├── value-objects/
│   ├── events/
│   ├── exceptions/
│   └── services/
├── application/
│   ├── ports/
│   │   ├── in/
│   │   └── out/
│   ├── use-cases/
│   └── dto/
├── infrastructure/
│   ├── persistence/
│   ├── storage/
│   ├── queue/
│   ├── ai/
│   └── transcription/
└── presentation/
    └── http/
        ├── controllers/
        ├── dto/
        └── mappers/
```

## Domain Layer

The domain contains business concepts and rules only.

Examples:

```text
Sermon
Church
ContentItem
ContentVersion
CalendarItem
Subscription
UsageRecord
PublishingJob
```

Domain entities should enforce invariants and valid state transitions. Domain code must remain testable without bootstrapping NestJS or connecting to infrastructure.

## Application Layer

The application layer contains use cases and ports.

Examples:

```text
CreateSermonUseCase
GetSermonUseCase
ListSermonsUseCase
ProcessSermonUseCase
GenerateMyWeekUseCase
ApproveContentUseCase
ScheduleContentUseCase
AskMinistryUseCase
```

Use cases orchestrate domain behavior and communicate with external capabilities only through output ports.

Example output ports:

```ts
export interface SermonRepositoryPort {
  save(sermon: Sermon): Promise<Sermon>;
  findById(id: string, churchId: string): Promise<Sermon | null>;
}

export interface TranscriptionPort {
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}

export interface AIServicePort {
  analyzeSermon(input: AnalyzeSermonInput): Promise<SermonIntelligence>;
  generateContent(input: GenerateContentInput): Promise<GeneratedContent>;
  embed(input: string[]): Promise<number[][]>;
}

export interface StoragePort {
  createUploadUrl(input: CreateUploadUrlInput): Promise<UploadUrl>;
  getObject(input: GetObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
}

export interface QueuePort {
  enqueue<T>(queue: string, job: string, payload: T): Promise<void>;
}

export interface PaymentPort {
  initializeSubscription(input: SubscriptionInput): Promise<PaymentResult>;
}
```

Input ports may be represented by use-case interfaces where useful. Controllers and queue consumers invoke these use cases.

## Infrastructure Adapters

Infrastructure implements output ports.

Examples:

```text
SermonRepositoryPort
        ↑
PrismaSermonRepository

AIServicePort
        ↑
OpenAIAdapter

TranscriptionPort
        ↑
OpenAITranscriptionAdapter

StoragePort
        ↑
CloudflareR2Adapter

QueuePort
        ↑
BullMQAdapter

PaymentPort
        ↑
PaystackAdapter

PublishingPort
        ↑
MetaPublishingAdapter
```

Provider-specific SDK types must not leak into the domain or application layers.

## Presentation Adapters

HTTP controllers are inbound adapters. They should:

1. authenticate/authorize the request;
2. validate transport input;
3. map HTTP DTOs to application input;
4. call a use case;
5. map the result to an HTTP response.

Controllers MUST NOT contain business rules, direct Prisma queries, OpenAI calls, queue orchestration, or storage logic.

BullMQ processors are also inbound adapters. They consume jobs and invoke application use cases rather than implementing business workflows directly inside processors.

## Sermon Processing Example

```text
POST /sermons
      ↓
SermonController
      ↓
CreateSermonUseCase
      ↓
SermonRepositoryPort ─────→ PrismaSermonRepository
      ↓
QueuePort ────────────────→ BullMQAdapter
      ↓
202 Accepted

Background Job
      ↓
BullMQ Processor
      ↓
ProcessSermonUseCase
      ├── StoragePort
      ├── TranscriptionPort
      ├── AIServicePort
      ├── EmbeddingPort
      └── SermonRepositoryPort
```

## AI Provider Abstraction

AI workflows are application-level concepts. Do not couple `analyzeSermon()` or `generateContent()` directly to OpenAI.

```text
Application
     ↓
AIServicePort
     ↓
┌──────────────┬─────────────────┬──────────────┐
│ OpenAIAdapter│ AnthropicAdapter│ GoogleAdapter│
└──────────────┴─────────────────┴──────────────┘
```

The initial implementation may use OpenAI, but replacing a provider must not require changes to domain entities or core use cases.

Use structured outputs and runtime validation for sermon intelligence and other important AI responses.

## Storage Abstraction

Do not couple sermon logic to AWS S3 or Cloudflare R2.

```text
StoragePort
   ↑
CloudflareR2Adapter
```

A future S3 adapter should be replaceable without modifying sermon use cases.

## Queue Architecture

BullMQ is an infrastructure detail.

Application code should request work through a queue port rather than importing BullMQ throughout the codebase.

Queues may include:

```text
sermon-processing
transcription
sermon-analysis
embeddings
content-generation
publishing
image-generation
video-generation
```

Long-running AI/media work must execute asynchronously.

## Persistence

Prisma belongs in infrastructure.

Do not pass Prisma models directly into the domain. Create persistence mappers:

```text
Prisma Model
     ↓
Persistence Mapper
     ↓
Domain Entity
```

and:

```text
Domain Entity
     ↓
Persistence Mapper
     ↓
Prisma Data
```

Repository interfaces belong to the application/core side; Prisma repository implementations belong to infrastructure.

## Testing Requirements

The architecture should allow use cases to be tested with in-memory/fake adapters.

For example:

```text
GenerateMyWeekUseCase
├── FakeSermonRepository
├── FakeContentRepository
├── FakeAIService
└── FakeQueue
```

Tests must cover:

- domain invariants;
- use cases independently of infrastructure;
- repository adapters;
- provider adapters;
- HTTP controllers;
- BullMQ processors;
- church-level data isolation;
- AI structured-output validation;
- failure/retry paths.

## Mandatory Codex Engineering Rules

1. Keep Abyde Sermon as a modular monolith for V1.
2. Use Hexagonal Architecture inside each major business module.
3. Domain code must be framework-independent.
4. Controllers contain no business logic.
5. Prisma repositories contain persistence logic, not business rules.
6. Use cases orchestrate application behavior.
7. Domain entities/value objects enforce domain invariants.
8. External providers are adapters behind ports.
9. Provider SDK types must not leak into the core.
10. BullMQ processors invoke use cases rather than implementing business logic themselves.
11. Every church-owned resource must be scoped by `churchId`.
12. Never trust `churchId` supplied by the frontend; derive ownership from the authenticated user/context.
13. Important AI output must be runtime validated before persistence.
14. Long-running work must be asynchronous.
15. Swapping OpenAI, R2/S3, Paystack, Meta, transcription providers, or video providers should not require rewriting core business logic.
16. Avoid unnecessary abstractions for purely internal code; ports should represent real boundaries.
17. Run lint, typecheck, tests, and production build after each implementation stage.
