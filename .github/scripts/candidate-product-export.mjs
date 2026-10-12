import assert from "node:assert/strict";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { descriptorDigest, validateDescriptor } from "./candidate-descriptor.mjs";
import { withVerifiedFile } from "./candidate-files.mjs";

// Runtime success is established later by the controller's completed-job API
// evidence. This bundle describes bytes, never its own acceptance.
export function productFiles(metadata, descriptor, platform, arch) {
  validateDescriptor(descriptor);
  assert.ok(["linux", "windows"].includes(platform));
  assert.ok(["x64", "arm64"].includes(arch));
  assert.equal(metadata.version, descriptor.version);
  assert.equal(metadata.sourceSha, descriptor.sourceSha);
  assert.equal(metadata.architecture, arch);
  const kinds = platform === "linux" ? ["deb", "rpm", "appimage"] : ["nsis"];
  return kinds.map((kind) => {
    const extension = { appimage: "AppImage", nsis: "exe" }[kind] ?? kind;
    const relative =
      platform === "linux" ? `candidate-${arch}.${extension}` : `candidate/candidate-${arch}.exe`;
    const record = platform === "linux" ? metadata.artifacts[kind] : metadata.installer;
    if (platform === "linux") assert.equal(record.file, relative);
    return {
      relative,
      artifact: {
        platform,
        arch,
        kind,
        name: `paseo-${descriptor.version}-${platform}-${arch}.${extension}`,
        bytes: record.bytes,
        sha256: record.sha256,
      },
    };
  });
}

export async function exportProducts(env, platform) {
  const context = JSON.parse(await readFile(env.CANDIDATE_CONTEXT, "utf8"));
  const { descriptor, runId, attempt } = context;
  assert.equal(runId, Number(env.GITHUB_RUN_ID));
  assert.equal(attempt, Number(env.GITHUB_RUN_ATTEMPT));
  assert.equal(descriptor.sourceSha, env.PASEO_CANDIDATE_SHA);
  assert.equal(descriptorDigest(descriptor), env.CANDIDATE_DESCRIPTOR_DIGEST);
  const arch = env.EXPECTED_ARCHITECTURE;
  const prefix = platform === "linux" ? "paseo-products" : "paseo-windows-products";
  const root = join(env.RUNNER_TEMP, `${prefix}-${runId}-${attempt}`);
  const metadata = JSON.parse(await readFile(join(root, "candidate.json"), "utf8"));
  const files = productFiles(metadata, descriptor, platform, arch);
  const directory = join(root, "candidate-export");
  await mkdir(directory); // Never reuse a previous export.
  for (const { relative, artifact } of files) {
    const output = await open(join(directory, artifact.name), "wx", 0o600);
    try {
      await withVerifiedFile(join(root, "packages", relative), artifact, async (body) => {
        for await (const chunk of body) await output.writeFile(chunk);
      });
    } finally {
      await output.close();
    }
  }
  await writeFile(
    join(directory, "candidate-products.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "paseo-candidate-products",
      descriptorSha256: descriptorDigest(descriptor),
      sourceSha: descriptor.sourceSha,
      treeSha: descriptor.treeSha,
      version: descriptor.version,
      runId,
      attempt,
      group: platform === "linux" ? `linux-products-${arch}` : `windows-${arch}`,
      artifacts: files.map(({ artifact }) => artifact),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await appendFile(env.GITHUB_OUTPUT, `directory=${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await exportProducts(process.env, process.argv[2]);
