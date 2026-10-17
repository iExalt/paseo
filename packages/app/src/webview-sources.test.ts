import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
// oxlint-disable-next-line import/no-relative-parent-imports -- the build script owns the hash
import { hashWebViewSources } from "../scripts/webview-source-hash.mjs";
import { fileEditorWebViewSources } from "./file-pane/editor/webview/file-editor-webview-html";
import { terminalEmulatorWebViewSources } from "./terminal/webview/terminal-emulator-webview-html";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

test.each([
  ["editor", fileEditorWebViewSources, "src/file-pane/editor/webview/entry.ts"],
  [
    "terminal",
    terminalEmulatorWebViewSources,
    "src/terminal/webview/terminal-emulator-webview-entry.ts",
  ],
])("the committed %s WebView was built from the current sources", async (_name, sources, entry) => {
  expect(sources.files).toContain(entry);
  const hash = await hashWebViewSources(appRoot, sources.files, sources.packages);
  expect(hash, "The WebView bundle is stale: run `npm run build:webviews`").toBe(sources.hash);
});
