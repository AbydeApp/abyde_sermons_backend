-- Reels (candidates, renders), word-level transcript timings, Brand Studio video settings,
-- source retention on sermon_assets and new usage units. Additive only: new tables, nullable or
-- defaulted columns, new enum values; existing rows keep their meaning (expires_at NULL = kept).
-- CreateEnum
CREATE TYPE "ReelStatus" AS ENUM ('DRAFT', 'QUEUED', 'PREPARING', 'CROPPING', 'ADDING_HOOK', 'ADDING_CAPTIONS', 'BRANDING', 'ENCODING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UsageUnit" ADD VALUE 'REEL_RENDERED';
ALTER TYPE "UsageUnit" ADD VALUE 'RENDER_SECOND';
ALTER TYPE "UsageUnit" ADD VALUE 'SOCIAL_PUBLICATION';

-- AlterTable
ALTER TABLE "sermon_assets" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transcript_segments" ADD COLUMN     "words" JSONB;

-- AlterTable
ALTER TABLE "brand_profiles" ADD COLUMN     "video_settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "reel_candidates" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "start_time_ms" INTEGER NOT NULL,
    "end_time_ms" INTEGER NOT NULL,
    "transcript" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reels" (
    "id" UUID NOT NULL,
    "church_id" UUID NOT NULL,
    "sermon_id" UUID NOT NULL,
    "candidate_id" UUID,
    "title" TEXT NOT NULL,
    "start_time_ms" INTEGER NOT NULL,
    "end_time_ms" INTEGER NOT NULL,
    "transcript" TEXT NOT NULL,
    "hook_text" TEXT,
    "hook_style" TEXT,
    "hook_options" JSONB NOT NULL DEFAULT '[]',
    "caption_style" TEXT NOT NULL,
    "caption_position" TEXT NOT NULL,
    "status" "ReelStatus" NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "render_attempt" INTEGER NOT NULL DEFAULT 0,
    "edited_since_render" BOOLEAN NOT NULL DEFAULT false,
    "output_asset_id" UUID,
    "thumbnail_asset_id" UUID,
    "duration_ms" INTEGER,
    "size_bytes" BIGINT,
    "error_message" TEXT,
    "approved_at" TIMESTAMP(3),
    "render_requested_at" TIMESTAMP(3),
    "rendered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reel_candidates_church_id_sermon_id_idx" ON "reel_candidates"("church_id", "sermon_id");

-- CreateIndex
CREATE UNIQUE INDEX "reel_candidates_sermon_id_rank_key" ON "reel_candidates"("sermon_id", "rank");

-- CreateIndex
CREATE INDEX "reels_church_id_created_at_idx" ON "reels"("church_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reels_church_id_sermon_id_idx" ON "reels"("church_id", "sermon_id");

-- CreateIndex
CREATE INDEX "reels_church_id_status_idx" ON "reels"("church_id", "status");

-- CreateIndex
CREATE INDEX "reels_sermon_id_idx" ON "reels"("sermon_id");

-- CreateIndex
CREATE INDEX "reels_status_updated_at_idx" ON "reels"("status", "updated_at");

-- CreateIndex
CREATE INDEX "sermon_assets_deleted_at_expires_at_idx" ON "sermon_assets"("deleted_at", "expires_at");

-- AddForeignKey
ALTER TABLE "reel_candidates" ADD CONSTRAINT "reel_candidates_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_candidates" ADD CONSTRAINT "reel_candidates_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_sermon_id_fkey" FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

