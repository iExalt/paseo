import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

assert.equal(process.arch, "arm64", "The feasibility probe must run native ARM64 Node.");
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
console.log(
  JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }),
);
const directory = await mkdtemp(join(tmpdir(), "paseo-native-probe-"));
try {
  // Report independent contracts even when one native dependency is unavailable.
  for (const [name, probe] of [
    [
      "pty",
      async () => {
        const packageDirectory = dirname(require.resolve("node-pty/package.json"));
        const prebuilt = spawnSync(process.execPath, ["scripts/prebuild.js"], {
          cwd: packageDirectory,
          encoding: "utf8",
          timeout: 10000,
        });
        console.log(prebuilt.stdout);
        if (prebuilt.status !== 0) {
          const build = spawnSync(
            process.execPath,
            [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild"],
            {
              cwd: packageDirectory,
              encoding: "utf8",
              timeout: 120000,
            },
          );
          console.log(build.stdout);
          assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stderr}`);
        }
        const pty = require("node-pty");
        console.log(`node-pty ${require("node-pty/package.json").version}`);
        const terminal = pty.spawn(
          process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          process.platform === "win32"
            ? ["/d", "/c", "echo paseo-native-pty"]
            : ["-c", "printf paseo-native-pty"],
          { cwd: directory, env: process.env },
        );
        try {
          await new Promise((resolve, reject) => {
            let output = "";
            const timer = setTimeout(() => reject(new Error("PTY did not exit in 10s")), 10000);
            terminal.onData((data) => {
              output += data;
            });
            terminal.onExit(({ exitCode }) => {
              clearTimeout(timer);
              if (exitCode === 0 && output.includes("paseo-native-pty")) resolve();
              else reject(new Error(`PTY exit ${exitCode}: ${output}`));
            });
          });
        } finally {
          terminal.kill();
        }
      },
    ],
    [
      "watcher",
      async () => {
        let watcher;
        let timer;
        try {
          await new Promise((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Watcher did not observe the file in 10s")),
              10000,
            );
            watcher = watch(directory, { recursive: true }, (_event, filename) => {
              if (filename?.toString() === "sentinel") resolve();
            });
            watcher.on("error", reject);
            writeFile(join(directory, "sentinel"), "native").catch(reject);
          });
        } finally {
          clearTimeout(timer);
          watcher?.close();
        }
      },
    ],
    [
      "sherpa",
      async () => {
        const nativePackage = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
        const libDir = dirname(require.resolve(`${nativePackage}/package.json`));
        console.log(`${nativePackage} ${require(`${nativePackage}/package.json`).version}`);
        const env = { ...process.env };
        const envKey =
          process.platform === "win32"
            ? (Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH")
            : "LD_LIBRARY_PATH";
        env[envKey] = `${libDir}${process.platform === "win32" ? ";" : ":"}${env[envKey] ?? ""}`;
        const script = `const assert=require('node:assert/strict'); const s=require(${JSON.stringify(require.resolve("sherpa-onnx-node"))}); const b=new s.CircularBuffer(8); b.push(new Float32Array([1,2])); assert.deepEqual(Array.from(b.get(0,2)),[1,2]); console.log(s.version);`;
        const result = spawnSync(process.execPath, ["-e", script], {
          env,
          encoding: "utf8",
          timeout: 10000,
        });
        assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
        console.log(result.stdout.trim());
      },
    ],
  ]) {
    try {
      await probe();
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}: ${error.stack}`);
      process.exitCode = 1;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
