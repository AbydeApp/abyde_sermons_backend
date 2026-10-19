-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('BRAND_LOGO', 'IMAGE', 'CAROUSEL_SLIDE', 'VIDEO', 'THUMBNAIL');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "brand_profiles" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "church_name" TEXT NOT NULL,
    "logo_asset_id" UUID,
    "alternate_logo_asset_id" UUID,
    "primary_color" TEXT NOT NULL,
    "secondary_color" TEXT NOT NULL,
    "accent_color" TEXT NOT NULL,
    "heading_font" TEXT NOT NULL,
    "body_font" TEXT NOT NULL,
    "social_handle" TEXT,
    "website" TEXT,
    "footer_text" TEXT,
    "watermark_enabled" BOOLEAN NOT NULL DEFAULT false,
    "watermark_position" TEXT,
    "voice" JSONB NOT NULL DEFAULT '{}',
    "template_defaults" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID,
    "content_item_id" UUID,
    "kind" "MediaAssetKind" NOT NULL,
    "status" "MediaAssetStatus" NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "render_group_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "render_spec" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_connections" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "encrypted_access_token" TEXT,
    "encrypted_refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "connected_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "content_item_id" UUID,
    "caption" TEXT NOT NULL,
    "title" TEXT,
    "media_asset_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "thumbnail_asset_id" UUID,
    "scheduled_at" TIMESTAMP(3),
    "timezone" TEXT,
    "status" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_publications" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "social_post_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_post_id" TEXT,
    "provider_ref" TEXT,
    "permalink" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "outcome_unknown" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "provider_metadata" JSONB NOT NULL DEFAULT '{}',
    "metrics" JSONB,
    "metrics_updated_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_audit_logs" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "connection_id" UUID,
    "social_post_id" UUID,
    "publication_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brand_profiles_church_id_key" ON "brand_profiles"("church_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_object_key_key" ON "media_assets"("object_key");

-- CreateIndex
CREATE INDEX "media_assets_church_id_content_item_id_idx" ON "media_assets"("church_id", "content_item_id");

-- CreateIndex
CREATE INDEX "media_assets_church_id_render_group_id_idx" ON "media_assets"("church_id", "render_group_id");

-- CreateIndex
CREATE INDEX "media_assets_content_item_id_idx" ON "media_assets"("content_item_id");

-- CreateIndex
CREATE INDEX "media_assets_status_updated_at_idx" ON "media_assets"("status", "updated_at");

-- CreateIndex
CREATE INDEX "social_connections_status_token_expires_at_idx" ON "social_connections"("status", "token_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_connections_church_id_platform_provider_account_id_key" ON "social_connections"("church_id", "platform", "provider_account_id");

-- CreateIndex
CREATE INDEX "social_posts_church_id_created_at_idx" ON "social_posts"("church_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "social_posts_church_id_status_idx" ON "social_posts"("church_id", "status");

-- CreateIndex
CREATE INDEX "social_posts_content_item_id_idx" ON "social_posts"("content_item_id");

-- CreateIndex
CREATE INDEX "social_posts_status_scheduled_at_idx" ON "social_posts"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "social_publications_church_id_status_idx" ON "social_publications"("church_id", "status");

-- CreateIndex
CREATE INDEX "social_publications_connection_id_idx" ON "social_publications"("connection_id");

-- CreateIndex
CREATE INDEX "social_publications_status_updated_at_idx" ON "social_publications"("status", "updated_at");

-- CreateIndex
CREATE INDEX "social_publications_status_published_at_idx" ON "social_publications"("status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_publications_social_post_id_connection_id_key" ON "social_publications"("social_post_id", "connection_id");

-- CreateIndex
CREATE INDEX "social_audit_logs_church_id_created_at_idx" ON "social_audit_logs"("church_id", "created_at");

-- AddForeignKey
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "social_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_audit_logs" ADD CONSTRAINT "social_audit_logs_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

