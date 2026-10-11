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
mkdirSync(work);
const evidence = join(root, "evidence/extraction.json");
const result = {
  complete: false,
  node: process.version,
  npm: "11.20.0",
  pacote: require("pacote/package.json").version,
  tar: execFileSync("tar.exe", ["--version"], { encoding: "utf8", timeout: 10000 }).trim(),
  ordering: "pacote then native tar; OS and Defender warming uncontrolled",
};
const save = () => writeFileSync(evidence, JSON.stringify(result, null, 2));
const protectionSnapshot = () => {
  try {
    return JSON.parse(
      execFileSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-Command",
          "$ErrorActionPreference='Stop'; $status=Get-MpComputerStatus; $cpu=@(Get-Process MsMpEng -ErrorAction SilentlyContinue | Select-Object Id,CPU); @{ realTimeProtection=$status.RealTimeProtectionEnabled; tamperProtection=$status.IsTamperProtected; processes=$cpu } | ConvertTo-Json -Depth 4 -Compress",
        ],
        { encoding: "utf8", timeout: 5000 },
      ),
    );
  } catch (error) {
    return { unavailable: error.message };
  }
};
result.protectionBefore = protectionSnapshot();
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
  const npmDestination = join(work, "pacote");
  const nativeDestination = join(work, "native");
  mkdirSync(npmDestination);
  mkdirSync(nativeDestination);
  const npmStart = performance.now();
  await pacote.extract(filename, npmDestination, {
    offline: true,
    integrity: entry.integrity,
    cache: join(work, "npm-cache"),
  });
  result.pacoteMs = performance.now() - npmStart;
  save();
  const nativeStart = performance.now();
  execFileSync("tar.exe", ["-xf", filename, "-C", nativeDestination, "--strip-components", "1"], {
    timeout: 120000,
    stdio: "inherit",
  });
  result.nativeTarMs = performance.now() - nativeStart;
  save();
  const inventory = (directory, prefix = "") =>
    readdirSync(directory)
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
  const npmFiles = inventory(npmDestination);
  assert.deepEqual(inventory(nativeDestination), npmFiles);
  result.files = npmFiles.length;
  result.extractedBytes = npmFiles.reduce((sum, item) => sum + item.bytes, 0);
  result.inventorySha256 = createHash("sha256").update(JSON.stringify(npmFiles)).digest("hex");
  const disk = statfsSync(work);
  result.availableDiskBytes = disk.bavail * disk.bsize;
  result.complete = true;
} finally {
  result.protectionAfter = protectionSnapshot();
  save();
}
