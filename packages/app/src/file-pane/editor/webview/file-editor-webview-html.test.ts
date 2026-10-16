import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
// oxlint-disable-next-line import/no-relative-parent-imports -- the build script owns the hash
import { hashWebViewSources } from "../../../../scripts/webview-source-hash.mjs";
import { fileEditorWebViewSources } from "./file-editor-webview-html";

const appRoot = fileURLToPath(new URL("../../../../", import.meta.url));

test("the committed editor WebView was built from the current sources", async () => {
  const hash = await hashWebViewSources(
    appRoot,
    fileEditorWebViewSources.files,
    fileEditorWebViewSources.packages,
  );
  expect(hash, "The editor WebView is stale: run `npm run build:webviews`").toBe(
    fileEditorWebViewSources.hash,
  );
  expect(fileEditorWebViewSources.files).toContain(
    path.join("src", "file-pane", "editor", "webview", "entry.ts"),
  );
});
