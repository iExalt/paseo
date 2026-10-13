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

export function builderChain(processes, pid, cwd, version) {
  const node = processes.get(pid);
  if (!node || !/^\/nix\/store\/[^/]+\/bin\/node$/.test(node.command)) return [];
  if (!/^\d+\.\d+\.\d+$/.test(version)) return [];
  const prefixes = ["n/tmp/", "n/private/tmp/"].map(
    (prefix) => `${prefix}nix-build-paseo-desktop-${version}.drv-`,
  );
  if (
    !cwd
      .split("\n")
      .some((line) =>
        prefixes.some(
          (prefix) => line.startsWith(prefix) && /^[^/]+(?:\/|$)/.test(line.slice(prefix.length)),
        ),
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
  const scanForMetro = () => {
    if (metroStarted) return;
    const fd = openSync(log, "r");
    try {
      const buffer = Buffer.alloc(65536);
      for (let count = 0; count < 16; count++) {
        const bytes = readSync(fd, buffer, 0, buffer.length, scanned);
        if (!bytes) break;
        scanned += bytes;
        const text = carry + buffer.subarray(0, bytes).toString("utf8");
        if (text.includes("Starting Metro Bundler")) {
          metroStarted = true;
          break;
        }
        carry = text.slice(-32);
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
    scanForMetro();
    const now = Date.now();
    const lastProgress = Math.max(started, statSync(log).mtimeMs);
    if (shouldSample({ now, lastProgress, lastSample, rounds, metroStarted })) {
      rounds++;
      lastSample = now;
      report("silent build", { seconds: Math.round((now - lastProgress) / 1000), round: rounds });
      report(capture("ps", ["-axo", "pid,ppid,state,etime,pcpu,rss,comm"]));
      report(capture("vm_stat", []));
      report(capture("sysctl", ["vm.swapusage"]));
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
        const chain = builderChain(processes, node.pid, cwd, version);
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
