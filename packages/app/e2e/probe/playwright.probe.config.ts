import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Runs agents' throwaway probes from the gitignored .dev/probes; see
// docs/agent-testing.md#browser-probes. Nothing here runs in CI.
const probesDir = path.resolve(__dirname, "../../../../.dev/probes");

export default defineConfig({
  testDir: probesDir,
  testMatch: "**/*.probe.ts",
  outputDir: path.join(probesDir, "artifacts"),
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
