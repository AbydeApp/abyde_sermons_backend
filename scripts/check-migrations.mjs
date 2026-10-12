// Migration safety checks for CI (run after `prisma migrate deploy` against an empty database).
// 1. Drift: the migrated database must match prisma/schema.prisma, except for the hand-written
//    indexes Prisma cannot express (trigram + HNSW), which are allow-listed below.
// 2. Data safety: no migration may contain destructive statements (DROP TABLE/COLUMN, TRUNCATE, ...)
//    or drop a protected index, unless the file is explicitly marked `-- abyde:allow-destructive`.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HAND_WRITTEN_INDEXES = [
  'sermons_title_trgm_idx',
  'sermons_speaker_trgm_idx',
  'sermons_series_trgm_idx',
  'sermons_main_scripture_trgm_idx',
  'content_items_title_trgm_idx',
  'content_items_body_trgm_idx',
  'sermon_embeddings_embedding_hnsw_idx',
];

const failures = [];

const diff = execFileSync(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
  ],
  { encoding: 'utf8' },
);
const statements = diff
  .split(';')
  .map((statement) => statement.replace(/--.*$/gm, '').trim())
  .filter(
    (statement) =>
      statement && !statement.startsWith('This is an empty migration'),
  );
for (const statement of statements) {
  const allowed = HAND_WRITTEN_INDEXES.some(
    (index) => statement === `DROP INDEX "${index}"`,
  );
  if (!allowed) failures.push(`Schema drift: ${statement}`);
}

const DESTRUCTIVE =
  /\b(DROP\s+(TABLE|COLUMN|TYPE|SCHEMA)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE)\b/i;
const migrationsDir = 'prisma/migrations';
for (const dir of readdirSync(migrationsDir, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory(),
)) {
  const sql = readFileSync(
    join(migrationsDir, dir.name, 'migration.sql'),
    'utf8',
  );
  if (sql.includes('-- abyde:allow-destructive')) continue;
  if (DESTRUCTIVE.test(sql))
    failures.push(
      `${dir.name}: destructive statement (see docs/MIGRATIONS.md)`,
    );
  for (const index of HAND_WRITTEN_INDEXES) {
    if (new RegExp(`DROP INDEX\\s+"?${index}"?`, 'i').test(sql))
      failures.push(`${dir.name}: drops protected index ${index}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  'Migrations OK: no drift beyond hand-written indexes, no destructive statements.',
);
