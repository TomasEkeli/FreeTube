import { defineConfig } from 'vitest/config'

// The fork's own test runner; upstream has none. Kept to this one file and
// the `test` script so that upstream syncs have nothing to conflict on.
// Tests sit beside the module they test, as `*.test.js`, and only the
// main-process modules under `src/main/` are tested, in plain Node.
export default defineConfig({
  test: {
    include: ['src/main/**/*.test.js'],
    environment: 'node',
  },
})
