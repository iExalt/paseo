import assert from "node:assert/strict";
import { win32 } from "node:path";

// fix: compare Windows spellings only after callers resolve filesystem identity.
export function windowsPathKey(resolvedPath) {
  assert.ok(win32.isAbsolute(resolvedPath), "Absolute resolved Windows path required");
  return win32.toNamespacedPath(resolvedPath).toLowerCase();
}
