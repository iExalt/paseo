import path from "node:path";
import { defineConfig } from "vitest/config";
import DurationSequencer from "./vitest.sequencer";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    sequence: { sequencer: DurationSequencer },
    pool: "forks",
    fileParallelism: false,
    // Even two concurrent Git-heavy suites can exhaust Windows test deadlines.
    // Run files serially so their subprocesses do not compete across suites.
    maxWorkers: process.platform === "win32" ? 1 : undefined,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.dev/**"],
  },
});
