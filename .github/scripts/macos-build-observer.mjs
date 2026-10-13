import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseProcesses(text) {
  const processes = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(
      line,
    );
    if (match) {
      const [, pid, parent, started, command] = match;
      processes.set(Number(pid), { pid: Number(pid), parent: Number(parent), started, command });
    }
  }
  return processes;
}

export function buildIdentity(line, outputPath, version) {
  const marker = "PASEO_DESKTOP_BUILD_IDENTITY=";
  const index = line.indexOf(marker);
  if (index === -1) return null;
  const identity = JSON.parse(line.slice(index + marker.length));
  assert.deepEqual(Object.keys(identity).sort(), ["output", "root"]);
  assert.equal(identity.output, outputPath);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const legacy = new RegExp(
    `^/(?:private/)?tmp/nix-build-paseo-desktop-${version.replaceAll(".", "\\.")}\\.drv-[A-Za-z0-9]+$`,
  );
  assert.ok(
    typeof identity.root === "string" &&
      (/^\/nix\/var\/nix\/builds\/nix-\d+-\d+$/.test(identity.root) || legacy.test(identity.root)),
    "Unrecognized exact desktop build root",
  );
  return identity;
}

export function builderChain(processes, pid, cwd, root) {
  const node = processes.get(pid);
  if (!node || !/^\/nix\/store\/[^/]+\/bin\/node$/.test(node.command)) return [];
  if (typeof root !== "string") return [];
  const prefix = `n${root}/source`;
  if (
    !cwd
      .split("\n")
      .some(
        (line) =>
          (line === prefix || line.startsWith(`${prefix}/`)) && !line.split("/").includes(".."),
      )
  )
    return [];
  const chain = [];
  while (processes.has(pid) && chain.length < 30 && !chain.some((item) => item.pid === pid)) {
    const process = processes.get(pid);
    chain.push(process);
    if (/\/nix-daemon(?:\s|$)/.test(process.command)) return chain;
    pid = process.parent;
  }
  return [];
}

export function sameChain(chain, current) {
  return (
    chain.length > 0 &&
    chain.every((item) => JSON.stringify(current.get(item.pid)) === JSON.stringify(item))
  );
}

export function shouldSample({ now, lastProgress, lastSample, rounds, metroStarted }) {
  return metroStarted && rounds < 2 && now - lastProgress >= 300000 && now - lastSample >= 300000;
}

async function observe(log, owner) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.ppid, owner);
  assert.equal(resolve(log), join(process.env.RUNNER_TEMP, "paseo-macos-build-stderr.log"));
  const version = process.env.FORK_VERSION;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const report = (...values) => console.error("macOS build observer:", ...values);
  let outputPath;
  let identity;
  let identityInvalid = false;
  try {
    const state = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, "paseo-nix-closure-state.json")),
    );
    assert.equal(state.forkVersion, version);
    assert.match(state.outputPath, /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-\d+\.\d+\.\d+$/);
    assert.ok(state.outputPath.endsWith(`-paseo-desktop-${version}`));
    outputPath = state.outputPath;
  } catch (error) {
    identityInvalid = true;
    report("sampling disabled: invalid prepared desktop identity", error.message);
  }
  const capture = (command, args, timeout = 8000) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
    } catch (error) {
      report("inspection failed", command, {
        status: error.status,
        signal: error.signal,
        message: error.message.slice(0, 1000),
      });
      return "";
    }
  };
  const table = () => parseProcesses(capture("ps", ["-axo", "pid=,ppid=,lstart=,comm="]));
  const finishSample = (chain, filename) => {
    try {
      if (sameChain(chain, table())) report(readFileSync(filename, "utf8").slice(0, 200000));
      else report("identity changed; sample is not attributable");
    } catch (error) {
      report("sample unavailable", error.code);
    }
    try {
      unlinkSync(filename);
    } catch (error) {
      if (error.code !== "ENOENT") report("sample cleanup failed", error.code);
    }
  };
  let stopped = false;
  let wake;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let metroStarted = false;
  let scanned = 0;
  let carry = "";
  const inspectLine = (line) => {
    if (line.includes("Starting Metro Bundler")) metroStarted = true;
    if (identityInvalid) return;
    try {
      const next = buildIdentity(line, outputPath, version);
      if (next) {
        if (identity) assert.deepEqual(next, identity, "Conflicting desktop build identity");
        identity = next;
      }
    } catch (error) {
      identityInvalid = true;
      report("sampling disabled: invalid build identity", error.message);
    }
  };
  const scanBuildLog = () => {
    const fd = openSync(log, "r");
    try {
      const buffer = Buffer.alloc(65536);
      for (let count = 0; count < 16; count++) {
        const bytes = readSync(fd, buffer, 0, buffer.length, scanned);
        if (!bytes) break;
        scanned += bytes;
        const lines = (carry + buffer.subarray(0, bytes).toString("utf8")).split("\n");
        carry = lines.pop();
        if (carry.length > 8192) {
          if (carry.includes("PASEO_DESKTOP_BUILD_IDENTITY=")) {
            identityInvalid = true;
            report("sampling disabled: oversized build identity");
          }
          carry = carry.slice(-8192);
        }
        for (const line of lines) inspectLine(line);
      }
    } finally {
      closeSync(fd);
    }
  };
  const started = Date.now();
  let lastSample = started;
  let rounds = 0;
  while (Date.now() - started < 55 * 60000) {
    if (stopped) break;
    scanBuildLog();
    const now = Date.now();
    const lastProgress = Math.max(started, statSync(log).mtimeMs);
    if (shouldSample({ now, lastProgress, lastSample, rounds, metroStarted })) {
      rounds++;
      lastSample = now;
      report("silent build", { seconds: Math.round((now - lastProgress) / 1000), round: rounds });
      report(capture("ps", ["-axo", "pid,ppid,state,etime,pcpu,rss,comm"]));
      report(capture("vm_stat", []));
      report(capture("sysctl", ["vm.swapusage"]));
      if (!identity || identityInvalid) {
        report("sampling disabled: missing or invalid exact build identity");
        continue;
      }
      const processes = table();
      let samples = 0;
      for (const node of processes.values()) {
        if (stopped || samples >= 3) break;
        if (!/^\/nix\/store\/[^/]+\/bin\/node$/.test(node.command)) continue;
        const cwd = capture("sudo", [
          "-n",
          "lsof",
          "-a",
          "-p",
          String(node.pid),
          "-d",
          "cwd",
          "-Fn",
        ]);
        const chain = builderChain(processes, node.pid, cwd, identity.root);
        if (!sameChain(chain, table())) continue;
        const filename = join(
          process.env.RUNNER_TEMP,
          `paseo-macos-sample-${process.pid}-${rounds}-${samples}.txt`,
        );
        samples++;
        report("sampling verified builder", { chain, cwd });
        capture("sudo", ["-n", "/usr/bin/sample", String(node.pid), "3", "10", "-file", filename]);
        finishSample(chain, filename);
      }
      report("sample count", samples);
    }
    if (!stopped)
      await new Promise((done) => {
        const timer = setTimeout(done, 10000);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
  }
  report("stopped", { rounds });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await observe(process.argv[2], Number(process.argv[3]));
}
