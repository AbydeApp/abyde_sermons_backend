import { defineConfig } from 'prisma/config';

// Load .env for local CLI use; deployed environments inject variables directly.
try {
  process.loadEnvFile();
} catch {
  // no .env file present
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --env-file=.env dist/seed.js',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
