import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_GATES } from "@/screens/settings/section-availability";
import {
  checkParity,
  findMissingImports,
  findSplitModules,
  type ParityManifest,
  type SourceModuleFacts,
} from "./check";
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

describe("findMissingImports", () => {
  it("reports imports a platform variant cannot satisfy", () => {
    const facts = new Map([
      ["a.tsx", { exports: ["A", "resolve"], imports: [] }],
      ["a.web.tsx", { exports: ["A"], imports: [] }],
      ["shared.tsx", { exports: [], imports: [{ module: "a", names: ["A", "resolve"] }] }],
      ["only-native.native.tsx", { exports: [], imports: [{ module: "a", names: ["resolve"] }] }],
      ["view.tsx", { exports: [], imports: [{ module: "a", names: ["resolve"] }] }],
      ["view.web.tsx", { exports: [], imports: [{ module: "a", names: ["A"] }] }],
    ]);
    expect(findMissingImports(facts)).toEqual([
      "shared.tsx imports resolve from a.web.tsx, which does not export it",
    ]);
  });
});

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

/** Resolves an import specifier to a module path under src without extension, or null. */
function resolveModule(importer: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = specifier.slice(2);
  else if (specifier.startsWith(".")) target = normalize(join(dirname(importer), specifier));
  else return null;
  return target
    .split(sep)
    .join("/")
    .replace(/\.tsx?$/, "");
}

function importedNames(clause: ts.ImportClause): string[] {
  const names = clause.name ? ["default"] : [];
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function declaredExportNames(statement: ts.Statement): string[] {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (statement.isTypeOnly || !clause || !ts.isNamedExports(clause)) return [];
    return clause.elements.filter((element) => !element.isTypeOnly).map((e) => e.name.text);
  }
  if (ts.isExportAssignment(statement)) return ["default"];
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement);
  return named && statement.name ? [statement.name.text] : [];
}

/** Runtime exports and named imports of a source file; `export *` is not followed. */
function moduleFacts(file: string): SourceModuleFacts {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(SRC_ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
  );
  const exports: string[] = [];
  const imports: { module: string; names: string[] }[] = [];
  for (const statement of source.statements) {
    exports.push(...declaredExportNames(statement));
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    const module = resolveModule(file, statement.moduleSpecifier.text);
    if (!clause || clause.isTypeOnly || !module) continue;
    const names = importedNames(clause);
    if (names.length > 0) imports.push({ module, names });
  }
  return { exports, imports };
}

function listSourceFiles(): string[] {
  const root = SRC_ROOT;
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

describe("platform variants", () => {
  it("export every name their importers use on each platform", () => {
    const files = listSourceFiles();
    expect(findMissingImports(new Map(files.map((file) => [file, moduleFacts(file)])))).toEqual([]);
  });
});
