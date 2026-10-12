# Database migrations

Goal: **no data loss and no downtime.** Production migrations must work with rolling deployments, meaning old and new code run against the same schema for a while.

## Rules

1. **Additive first (expand → migrate → contract).** Add new columns or tables as nullable or defaulted, deploy code that writes both shapes, backfill, and only drop the old shape in a later release once no deployed code reads it.
2. **No destructive statements** (`DROP TABLE/COLUMN/TYPE`, `TRUNCATE`, `DELETE FROM`, column type changes) unless the migration file contains `-- abyde:allow-destructive` and the change was reviewed. `npm run db:check` and CI enforce this.
3. **Large tables:** create indexes with `CREATE INDEX CONCURRENTLY` in their own migration, and backfill in batches from a job, not inside the migration.
4. Never edit a migration that has been applied anywhere. Add a new one.
5. Never mutate production data by hand as part of feature work.

## Hand-written indexes (Prisma cannot express them)

The initial migration creates these by hand:

- `pg_trgm` GIN indexes for substring search: `sermons(title|speaker|series|main_scripture)`, `content_items(title|body)`
- HNSW cosine index on `sermon_embeddings.embedding`
- the `vector` and `pg_trgm` extensions

`prisma migrate dev` doesn't know about them and **will generate `DROP INDEX` statements for them**. Before committing a generated migration, delete those statements. `npm run db:check` fails if any migration drops one.

## Migrations so far

- `…_init`: full schema, extensions, trigram and HNSW indexes.
- `20261003090000_fk_and_sweep_indexes`: additive indexes on `sermon_id` foreign keys (cascade deletes) and on `(status, updated_at)` for the stuck-work recovery sweeps.
- `20261003190000_brand_studio_social`: additive only. New tables `brand_profiles`, `media_assets`, `social_connections`, `social_posts`, `social_publications`, `social_audit_logs` (and the `MediaAssetKind` / `MediaAssetStatus` enums), with tenant, FK and sweep indexes. Social status columns are text validated in the domain, so new provider states need no enum migration.

- `20261004120000_reels_word_timings_retention`: additive only. New tables `reel_candidates` and `reels` (and the `ReelStatus` enum) with tenant, FK and sweep indexes; nullable `transcript_segments.words` (word timings as `[text, startMs, endMs]` tuples); `brand_profiles.video_settings` (JSONB, default `{}`); nullable `sermon_assets.expires_at` / `deleted_at` with a sweep index (existing uploads keep `NULL`, meaning "kept"); new `UsageUnit` values `REEL_RENDERED`, `RENDER_SECOND`, `SOCIAL_PUBLICATION`. `sermon_assets` has one row per sermon, so its index is created inline.

## Creating a migration

```bash
# edit prisma/schema.prisma, then:
npx prisma migrate dev --create-only --name <change>
# review prisma/migrations/<ts>_<change>/migration.sql:
#   - remove DROP INDEX lines for the hand-written indexes above
#   - check the expand/contract rules
npm run db:migrate          # apply locally
npm run db:check            # drift + destructive-statement guard
```

## Deploying

Migrations run as a separate one-off job (the image's `migrate` target, `prisma migrate deploy`) **before** the new API and worker versions roll out. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Vector index tuning

Semantic search filters by `church_id` inside the ANN scan and uses pgvector ≥ 0.8 iterative scans (`hnsw.iterative_scan = relaxed_order`, `hnsw.ef_search = 100`), so recall holds when one church is a small slice of the index. Revisit `m`/`ef_construction` once there are more than a few million embedding rows. Partitioning by church is the next step if needed.
