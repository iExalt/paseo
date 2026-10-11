import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32");
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
assert.equal(process.version, "v26.11.0");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const root = resolve(process.argv[2]);
assert.equal(
  root,
  resolve(
    process.env.RUNNER_TEMP,
    `paseo-windows-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  ),
);
const npmRoot = join(dirname(process.execPath), "node_modules/npm");
assert.equal(JSON.parse(readFileSync(join(npmRoot, "package.json"))).version, "11.20.0");
const require = createRequire(join(npmRoot, "package.json"));
const pacote = require("pacote");
const tar = require("tar");
const work = join(root, "extraction-diagnostic");
const integrity =
  "sha512-BCkyiFbeCAKvM1q+1GMFbAT6+eq57trBXt4ETyLtWaxGM2X4Ux/iff1S5B/wwDnfcWytcfJo03MkKzHnHFcpyw==";
if (process.argv[3]) {
  const label = process.argv[3];
  assert.match(label, /^pass-[0-3]$/);
  assert.ok(["4", "16"].includes(process.env.UV_THREADPOOL_SIZE));
  const destination = join(work, label);
  mkdirSync(destination);
  const started = performance.now();
  const cpu = process.cpuUsage();
  await pacote.extract(join(work, "package.tgz"), destination, {
    offline: true,
    integrity,
    cache: join(work, `${label}-cache`),
  });
  const elapsedMs = performance.now() - started;
  const cpuUsage = process.cpuUsage(cpu);
  const files = inventory(destination);
  writeFileSync(
    join(root, "evidence", `${label}.json`),
    JSON.stringify({
      workers: Number(process.env.UV_THREADPOOL_SIZE),
      elapsedMs,
      cpuUsage,
      peakMemoryKiB: process.resourceUsage().maxRSS,
      files: files.length,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    }),
  );
  process.exit(0);
}
mkdirSync(work);
const evidence = join(root, "evidence/extraction.json");
const result = {
  complete: false,
  node: process.version,
  npm: "11.20.0",
  pacote: require("pacote/package.json").version,
  ordering:
    "fresh-process ABBA filesystem workers 4,16,16,4; same archive, fresh destinations and caches",
  passes: [],
};
const save = () => writeFileSync(evidence, JSON.stringify(result, null, 2));
save();
try {
  const lock = JSON.parse(readFileSync("package-lock.json"));
  const entry = lock.packages["node_modules/lucide-react-native"];
  assert.equal(entry.version, "1.52.0");
  assert.equal(
    entry.resolved,
    "https://registry.npmjs.org/lucide-react-native/-/lucide-react-native-1.52.0.tgz",
  );
  assert.equal(
    entry.integrity,
    "sha512-BCkyiFbeCAKvM1q+1GMFbAT6+eq57trBXt4ETyLtWaxGM2X4Ux/iff1S5B/wwDnfcWytcfJo03MkKzHnHFcpyw==",
  );
  const started = performance.now();
  const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= 64 * 1024 * 1024, "Bounded archive download");
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, entry.integrity);
  result.download = { elapsedMs: performance.now() - started, bytes, integrity: entry.integrity };
  const filename = join(work, "package.tgz");
  writeFileSync(filename, archive, { flag: "wx" });
  let entries = 0;
  let expandedBytes = 0;
  await tar.t({
    file: filename,
    onReadEntry(item) {
      assert.ok(["File", "Directory"].includes(item.type));
      assert.ok(item.path.startsWith("package/") && !item.path.split("/").includes(".."));
      assert.ok(!item.path.includes("\\") && !item.path.includes(":"));
      entries++;
      expandedBytes += item.size;
      assert.ok(entries <= 50000 && expandedBytes <= 256 * 1024 * 1024);
    },
  });
  result.archive = { entries, expandedBytes };
  save();
  for (const [index, workers] of [4, 16, 16, 4].entries()) {
    const label = `pass-${index}`;
    result.activePass = label;
    save();
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), root, label], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(workers) },
      stdio: "inherit",
      timeout: 90000,
    });
    const pass = JSON.parse(readFileSync(join(root, "evidence", `${label}.json`)));
    assert.equal(pass.workers, workers);
    if (result.passes.length) {
      for (const key of ["files", "bytes", "inventorySha256"])
        assert.equal(pass[key], result.passes[0][key]);
    }
    result.passes.push(pass);
    save();
  }
  result.activePass = null;
  const disk = statfsSync(work);
  result.availableDiskBytes = disk.bavail * disk.bsize;
  result.complete = true;
} finally {
  save();
}

function inventory(directory, prefix = "") {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const file = join(directory, name);
      const stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      const relative = `${prefix}${name}`;
      if (stat.isDirectory()) return inventory(file, `${relative}/`);
      assert.ok(stat.isFile());
      return [
        {
          name: relative,
          bytes: stat.size,
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        },
      ];
    });
}
