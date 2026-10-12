-- Additive only: indexes for foreign-key lookups / cascade deletes and for the maintenance sweeps.
-- (Generated DROP INDEX lines for the hand-written trigram/HNSW indexes were removed; see docs/MIGRATIONS.md.)

-- CreateIndex
CREATE INDEX "content_items_sermon_id_idx" ON "content_items"("sermon_id");

-- CreateIndex
CREATE INDEX "generation_groups_sermon_id_idx" ON "generation_groups"("sermon_id");

-- CreateIndex
CREATE INDEX "generation_jobs_status_updated_at_idx" ON "generation_jobs"("status", "updated_at");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "scripture_references_sermon_id_idx" ON "scripture_references"("sermon_id");

-- CreateIndex
CREATE INDEX "sermon_assets_sermon_id_idx" ON "sermon_assets"("sermon_id");

-- CreateIndex
CREATE INDEX "sermon_embeddings_sermon_id_idx" ON "sermon_embeddings"("sermon_id");

-- CreateIndex
CREATE INDEX "sermons_status_updated_at_idx" ON "sermons"("status", "updated_at");

-- CreateIndex
CREATE INDEX "transcript_segments_sermon_id_idx" ON "transcript_segments"("sermon_id");

-- CreateIndex
CREATE INDEX "uploads_consumed_at_created_at_idx" ON "uploads"("consumed_at", "created_at");

