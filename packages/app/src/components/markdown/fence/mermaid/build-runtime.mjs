import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "../../../../..");
const repoRoot = path.resolve(appRoot, "../..");
const entry = path.join(__dirname, "runtime/entry.ts");
const output = path.join(__dirname, "runtime/html.gen.ts");
const buildDeps = path.join(__dirname, "build-deps");
const { build } = createRequire(path.join(buildDeps, "package.json"))("esbuild");
const mermaid = path.join(buildDeps, "node_modules/mermaid/dist");
const patchedChunks = new Set();

async function readPinnedChunk(filename, expectedHash) {
  const source = await fs.readFile(filename, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
    throw new Error(`Unexpected Mermaid 11.16.0 chunk: ${filename}`);
  }
  patchedChunks.add(filename);
  return source;
}

const result = await build({
  entryPoints: [entry],
  bundle: true,
  alias: { mermaid: path.join(mermaid, "mermaid.core.mjs") },
  plugins: [
    {
      name: "mermaid-11-backports",
      setup(builder) {
        builder.onLoad({ filter: /chunk-PUDLZKDR\.mjs$/ }, async ({ path: filename }) => {
          const source = await readPinnedChunk(
            filename,
            "caa199d84f70a58f91fde8253b352cb8d265c5c9bc149b6f31218b3db7f06c40",
          );
          // Retain the lexer backport from bcf52f93b for @ inside flowchart labels.
          return {
            contents: source.replace(
              String.raw`[^\s\"]+@(?=[^\{\"])`,
              String.raw`[^\s\"\[\]\(\)\{\}\|]+@(?=[^\{\"])`,
            ),
            resolveDir: path.dirname(filename),
          };
        });
        builder.onLoad({ filter: /chunk-ZIRB5QZD\.mjs$/ }, async ({ path: filename }) => {
          // Mermaid ships its own js-yaml 4.1.1 here. Use the same two exports
          // from the locked 4.3.2 package to preserve the v4 parsing contract.
          await readPinnedChunk(
            filename,
            "d42ba504dce7190757d74d7cf079dc3fcaa35f42de993962b0104dc03e522972",
          );
          const yamlRoot = path.join(buildDeps, "node_modules/js-yaml");
          const { version } = JSON.parse(
            await fs.readFile(path.join(yamlRoot, "package.json"), "utf8"),
          );
          const license = (await fs.readFile(path.join(yamlRoot, "LICENSE"), "utf8")).trim();
          return {
            contents: `/*! js-yaml ${version}\n${license}\n*/\nexport { JSON_SCHEMA, load } from "js-yaml";`,
            resolveDir: path.dirname(filename),
          };
        });
      },
    },
  ],
  write: false,
  format: "iife",
  platform: "browser",
  target: ["ios15", "chrome100"],
  minify: true,
  // The app's deployment floor is iOS 15.1 but structuredClone (used by
  // mermaid) only exists from iOS 15.4; esbuild targets transform syntax,
  // not runtime APIs. Mermaid only clones plain config objects, so a
  // JSON-based fallback is sufficient.
  banner: {
    js: 'if(typeof globalThis.structuredClone!=="function"){globalThis.structuredClone=function(v){return v===undefined?v:JSON.parse(JSON.stringify(v));};}',
  },
  logLevel: "info",
});

if (patchedChunks.size !== 2) {
  throw new Error("Mermaid runtime bundle is missing an expected backport");
}
const rawJs = result.outputFiles[0]?.text;
if (!rawJs) {
  throw new Error("Mermaid runtime bundle produced no JavaScript");
}
// JSON.stringify below escapes the TypeScript representation, not the runtime
// HTML — an embedded closing-script sequence would still terminate the inline
// <script>. `<\/script` is identical to `</script` inside JS strings/regex.
const js = rawJs.replace(/<\/script/gi, "<\\/script");

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        height: 100%;
      }
      /* The host sizes this frame to the diagram, so the diagram fills the frame. */
      #diagram {
        height: 100%;
      }
      #diagram svg {
        display: block;
      }
      /* Keep Mermaid's temporary render container unscaled when the host mounts this frame
         at 0x0 or 240x240 before the diagram's own dimensions are known. */
      #staging-clip {
        position: fixed;
        width: 0;
        height: 0;
        overflow: hidden;
        visibility: hidden;
        pointer-events: none;
      }
      #staging {
        width: 16384px;
        height: 16384px;
      }
    </style>
  </head>
  <body>
    <div id="diagram"></div>
    <div id="staging-clip" aria-hidden="true"><div id="staging"></div></div>
    <script>${js}</script>
  </body>
</html>`;

const contents = `// Generated by packages/app/src/components/markdown/fence/mermaid/build-runtime.mjs.
// Do not edit by hand.

export const mermaidRuntimeHtml = ${JSON.stringify(html)};
`;

await fs.writeFile(output, contents);
console.log(`Wrote ${path.relative(repoRoot, output)} (${html.length} bytes)`);
