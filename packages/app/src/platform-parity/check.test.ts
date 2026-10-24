import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_GATES } from "@/screens/settings/section-availability";
import { checkParity, findSplitModules, type ParityManifest } from "./check";
import { PARITY_MANIFEST } from "./manifest";

const emptyManifest: ParityManifest = { splitModules: {}, settingsSections: {}, runtimeGates: {} };

describe("findSplitModules", () => {
  it("finds modules that resolve to different files on web and native", () => {
    expect(
      findSplitModules([
        "a.native.tsx",
        "a.web.tsx",
        "b.tsx",
        "b.electron.tsx",
        "c.ios.tsx",
        "c.web.tsx",
        "d.android.ts",
        "d.web.ts",
        "e.tsx",
        "e.web.tsx",
        "e.electron.tsx",
        "f.ts",
        "f.native.ts",
      ]),
    ).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("ignores single-platform modules, tests and declarations", () => {
    expect(
      findSplitModules([
        "only-web.web.tsx",
        "only-native.native.tsx",
        "plain.ts",
        "slot.native.tsx",
        "slot.d.ts",
        "x.web.test.tsx",
        "x.test.tsx",
        "y.web.browser.test.tsx",
        "y.tsx",
      ]),
    ).toEqual([]);
  });
});

describe("checkParity", () => {
  it("fails on an unclassified split module", () => {
    expect(
      checkParity(
        { files: ["a.native.tsx", "a.web.tsx"], gatedSettingsSections: [] },
        emptyManifest,
      ),
    ).toEqual(["split module a is not classified in the parity manifest"]);
  });

  it("fails on stale entries and on gaps without a reason", () => {
    const manifest: ParityManifest = {
      splitModules: { gone: { kind: "equivalent" } },
      settingsSections: { editor: { kind: "gap", chunk: "E1", reason: " " } },
      runtimeGates: { "gone.ts": { kind: "deliberate", reason: "Needs Electron" } },
    };
    expect(checkParity({ files: [], gatedSettingsSections: ["editor"] }, manifest)).toEqual([
      "split module gone is no longer split",
      "settings section editor has no reason",
      "runtime gate gone.ts no longer exists",
    ]);
  });

  it("fails on gated settings sections that are unclassified or no longer gated", () => {
    const manifest: ParityManifest = {
      ...emptyManifest,
      settingsSections: { browser: { kind: "deliberate", reason: "Needs Electron" } },
    };
    expect(checkParity({ files: [], gatedSettingsSections: ["editor"] }, manifest)).toEqual([
      "settings section editor is gated but not classified",
      "settings section browser is no longer gated",
    ]);
  });
});

function listSourceFiles(): string[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => file.split(sep).join("/"));
}

describe("platform parity manifest", () => {
  it("classifies every platform difference in the app", () => {
    expect(
      checkParity(
        { files: listSourceFiles(), gatedSettingsSections: Object.keys(SETTINGS_SECTION_GATES) },
        PARITY_MANIFEST,
      ),
    ).toEqual([]);
  });
});
