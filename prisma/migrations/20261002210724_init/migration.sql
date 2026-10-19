-- Extensions: pgvector for embeddings, pg_trgm for indexed substring search.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "SermonStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'QUEUED', 'TRANSCRIBING', 'ANALYZING', 'INDEXING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProcessingStage" AS ENUM ('UPLOAD', 'MEDIA', 'TRANSCRIBE', 'UNDERSTAND', 'SCRIPTURES', 'INTELLIGENCE', 'INDEX');

-- CreateEnum
CREATE TYPE "SermonSourceType" AS ENUM ('MEDIA', 'DOCUMENT', 'TEXT');

-- CreateEnum
CREATE TYPE "UploadPurpose" AS ENUM ('SERMON_MEDIA', 'CHURCH_LOGO');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('DEVOTIONAL', 'SOCIAL_POST', 'PRAYER', 'BIBLE_STUDY', 'EMAIL', 'WHATSAPP', 'QUOTE', 'VIDEO_IDEA');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentVersionSource" AS ENUM ('AI_GENERATED', 'AI_REWRITE', 'USER_EDIT');

-- CreateEnum
CREATE TYPE "CalendarItemStatus" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "PublishAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "UsageUnit" AS ENUM ('SERMON_PROCESSED', 'CONTENT_GENERATED', 'TRANSCRIPTION_MINUTE', 'TEXT_GENERATION', 'EMBEDDING', 'IMAGE_GENERATION', 'VIDEO_GENERATION', 'STORAGE_BYTES');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('META', 'WHATSAPP', 'EMAIL', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'NON_RENEWING', 'PAST_DUE', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "churches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_role" TEXT NOT NULL,
    "denomination" TEXT,
    "website" TEXT,
    "description" TEXT,
    "preferred_bible_translation" TEXT NOT NULL DEFAULT 'NIV',
    "primary_color" TEXT,
    "secondary_color" TEXT,
    "devotional_tone" TEXT,
    "social_tone" TEXT,
    "audience_description" TEXT NOT NULL DEFAULT '',
    "words_to_avoid" TEXT NOT NULL DEFAULT '',
    "additional_ai_context" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "churches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "purpose" "UploadPurpose" NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sermons" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "sermon_date" TIMESTAMP(3) NOT NULL,
    "series" TEXT,
    "main_scripture" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SermonStatus" NOT NULL,
    "processing_stage" "ProcessingStage",
    "failed_stage" "ProcessingStage",
    "error_message" TEXT,
    "can_retry" BOOLEAN NOT NULL DEFAULT false,
    "source_type" "SermonSourceType" NOT NULL,
    "summary" TEXT,
    "main_theme" TEXT,
    "themes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scriptures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duration_ms" INTEGER,
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "ready_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sermons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sermon_assets" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sermon_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "full_text" TEXT NOT NULL,
    "language" TEXT,
    "provider" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_time_ms" INTEGER NOT NULL,
    "end_time_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker_label" TEXT,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sermon_intelligence" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "ai_provider" TEXT NOT NULL,
    "ai_model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sermon_intelligence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripture_references" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "book" TEXT NOT NULL,
    "chapter" INTEGER NOT NULL,
    "verse_start" INTEGER,
    "verse_end" INTEGER,
    "translation" TEXT,
    "verified" BOOLEAN NOT NULL,
    "display" TEXT NOT NULL,
    "source_segment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scripture_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sermon_embeddings" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "transcript_segment_id" UUID,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sermon_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_groups" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "status" "JobStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "generation_job_id" UUID,
    "type" "ContentType" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scripture" TEXT,
    "platform" TEXT,
    "status" "ContentStatus" NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "source_metadata" JSONB NOT NULL DEFAULT '{}',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_versions" (
    "id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scripture" TEXT,
    "source" "ContentVersionSource" NOT NULL,
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_items" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "CalendarItemStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL,
    "encrypted_credentials" TEXT,
    "external_account_id" TEXT,
    "account_label" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "PublishAttemptStatus" NOT NULL,
    "external_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "unit" "UsageUnit" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "sermon_id" UUID,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL,
    "church_id" UUID,
    "sermon_id" UUID,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_customers" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "external_subscription_id" TEXT,
    "external_email_token" TEXT,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_allowances" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "sermons_limit" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "churches_user_id_key" ON "churches"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "churches_slug_key" ON "churches"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "uploads_object_key_key" ON "uploads"("object_key");

-- CreateIndex
CREATE INDEX "uploads_church_id_created_at_idx" ON "uploads"("church_id", "created_at");

-- CreateIndex
CREATE INDEX "sermons_church_id_sermon_date_idx" ON "sermons"("church_id", "sermon_date" DESC);

-- CreateIndex
CREATE INDEX "sermons_church_id_status_idx" ON "sermons"("church_id", "status");

-- CreateIndex
CREATE INDEX "sermons_church_id_created_at_idx" ON "sermons"("church_id", "created_at");

-- CreateIndex
CREATE INDEX "sermons_tags_idx" ON "sermons" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "sermons_themes_idx" ON "sermons" USING GIN ("themes");

-- CreateIndex
CREATE INDEX "sermons_scriptures_idx" ON "sermons" USING GIN ("scriptures");

-- CreateIndex
CREATE UNIQUE INDEX "sermon_assets_object_key_key" ON "sermon_assets"("object_key");

-- CreateIndex
CREATE INDEX "sermon_assets_church_id_sermon_id_idx" ON "sermon_assets"("church_id", "sermon_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_sermon_id_key" ON "transcripts"("sermon_id");

-- CreateIndex
CREATE INDEX "transcripts_church_id_idx" ON "transcripts"("church_id");

-- CreateIndex
CREATE INDEX "transcript_segments_church_id_sermon_id_sequence_idx" ON "transcript_segments"("church_id", "sermon_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_transcript_id_sequence_key" ON "transcript_segments"("transcript_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "sermon_intelligence_sermon_id_key" ON "sermon_intelligence"("sermon_id");

-- CreateIndex
CREATE INDEX "sermon_intelligence_church_id_idx" ON "sermon_intelligence"("church_id");

-- CreateIndex
CREATE INDEX "scripture_references_church_id_sermon_id_idx" ON "scripture_references"("church_id", "sermon_id");

-- CreateIndex
CREATE INDEX "scripture_references_church_id_book_idx" ON "scripture_references"("church_id", "book");

-- CreateIndex
CREATE INDEX "sermon_embeddings_church_id_sermon_id_idx" ON "sermon_embeddings"("church_id", "sermon_id");

-- CreateIndex
CREATE INDEX "generation_groups_church_id_sermon_id_created_at_idx" ON "generation_groups"("church_id", "sermon_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "generation_jobs_church_id_status_idx" ON "generation_jobs"("church_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_group_id_content_type_key" ON "generation_jobs"("group_id", "content_type");

-- CreateIndex
CREATE INDEX "content_items_church_id_status_idx" ON "content_items"("church_id", "status");

-- CreateIndex
CREATE INDEX "content_items_church_id_sermon_id_idx" ON "content_items"("church_id", "sermon_id");

-- CreateIndex
CREATE INDEX "content_items_church_id_updated_at_idx" ON "content_items"("church_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "content_items_church_id_type_idx" ON "content_items"("church_id", "type");

-- CreateIndex
CREATE INDEX "content_items_generation_job_id_idx" ON "content_items"("generation_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_content_item_id_version_key" ON "content_versions"("content_item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_items_content_item_id_key" ON "calendar_items"("content_item_id");

-- CreateIndex
CREATE INDEX "calendar_items_church_id_scheduled_at_idx" ON "calendar_items"("church_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "calendar_items_status_scheduled_at_idx" ON "calendar_items"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_church_id_provider_key" ON "integrations"("church_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_idempotency_key_key" ON "publish_attempts"("idempotency_key");

-- CreateIndex
CREATE INDEX "publish_attempts_church_id_created_at_idx" ON "publish_attempts"("church_id", "created_at");

-- CreateIndex
CREATE INDEX "publish_attempts_content_item_id_idx" ON "publish_attempts"("content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_dedupe_key_key" ON "usage_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "usage_events_church_id_created_at_idx" ON "usage_events"("church_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_events_church_id_unit_created_at_idx" ON "usage_events"("church_id", "unit", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_church_id_created_at_idx" ON "ai_usage_logs"("church_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_operation_created_at_idx" ON "ai_usage_logs"("operation", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_church_id_key" ON "billing_customers"("church_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_provider_external_customer_id_key" ON "billing_customers"("provider", "external_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_church_id_key" ON "subscriptions"("church_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions"("external_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_allowances_church_id_key" ON "usage_allowances"("church_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "churches" ADD CONSTRAINT "churches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermons" ADD CONSTRAINT "sermons_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_assets" ADD CONSTRAINT "sermon_assets_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_intelligence" ADD CONSTRAINT "sermon_intelligence_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripture_references" ADD CONSTRAINT "scripture_references_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_embeddings" ADD CONSTRAINT "sermon_embeddings_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_groups" ADD CONSTRAINT "generation_groups_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_groups" ADD CONSTRAINT "generation_groups_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "generation_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_items" ADD CONSTRAINT "calendar_items_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_items" ADD CONSTRAINT "calendar_items_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_allowances" ADD CONSTRAINT "usage_allowances_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written indexes (not expressible in Prisma schema) ──

-- Trigram indexes back the ILIKE '%q%' sermon/content searches.
CREATE INDEX "sermons_title_trgm_idx" ON "sermons" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "sermons_speaker_trgm_idx" ON "sermons" USING GIN ("speaker" gin_trgm_ops);
CREATE INDEX "sermons_series_trgm_idx" ON "sermons" USING GIN ("series" gin_trgm_ops);
CREATE INDEX "sermons_main_scripture_trgm_idx" ON "sermons" USING GIN ("main_scripture" gin_trgm_ops);
CREATE INDEX "content_items_title_trgm_idx" ON "content_items" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "content_items_body_trgm_idx" ON "content_items" USING GIN ("body" gin_trgm_ops);

-- Approximate nearest-neighbour index for cosine distance. Queries always also filter by church_id.
CREATE INDEX "sermon_embeddings_embedding_hnsw_idx" ON "sermon_embeddings" USING hnsw ("embedding" vector_cosine_ops);
