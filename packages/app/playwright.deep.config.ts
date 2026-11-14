import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// Keep this bounded journey separate from the full browser/provider inventory.
export default defineConfig({
  ...base,
  testMatch: ["new-workspace-launch-terminal.spec.ts"],
  workers: 1,
  retries: 0,
  globalTimeout: 600_000,
  outputDir: "../../.dev/github-workflows/deep/browser",
  use: {
    ...base.use,
    trace: "on",
    screenshot: "on",
    video: "off",
  },
  projects: [{ name: "browser", use: { ...devices["Desktop Chrome"] } }],
});
