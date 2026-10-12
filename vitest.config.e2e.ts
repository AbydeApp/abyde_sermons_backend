import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Each suite boots the whole app and hashes passwords (deliberately CPU-heavy). Running the
    // files one at a time keeps timings stable; in parallel they caused rare socket resets.
    fileParallelism: false,
  },
});
