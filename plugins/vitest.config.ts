import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Cross-workspace usage contracts exercise the app's pinning helpers.
    alias: { "@": fileURLToPath(new URL("../packages/app/src", import.meta.url)) },
  },
});
