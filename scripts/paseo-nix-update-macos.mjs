// macOS integration for the Nix updater: the /Applications/Paseo.app copy,
// LaunchServices registrations and Dock tiles. Every failure here is reported
// on stderr and never fails or undoes a profile switch.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const INSTALLED_APP = "/Applications/Paseo.app";
export const NIX_MANAGED_MARKER = join("Contents", "Resources", "paseo-nix-managed.json");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const STORE_OUTPUT = /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/\s]+$/;

export const appBundle = (outputPath) => join(outputPath, "Applications", "Paseo.app");

function warn(what, error) {
  process.stderr.write(`${what}: ${error instanceof Error ? error.message : String(error)}\n`);
}

function run(command, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!allowFailure)
    assert.equal(
      result.status,
      0,
      `${basename(command)} ${args[0]} failed: ${result.stderr.trim()}`,
    );
  return result;
}

// Release builds since installed copies record their own store output in the
// sealed marker, so a copy outside /nix/store can still find its updater. Older
// releases have no outputPath and keep running from the store.
export function markerOutputPath(text) {
  try {
    const marker = JSON.parse(text);
    if (marker?.managedBy !== "nix") return { managed: false, outputPath: null };
    const outputPath =
      typeof marker.outputPath === "string" && STORE_OUTPUT.test(marker.outputPath)
        ? marker.outputPath
        : null;
    return { managed: true, outputPath };
  } catch {
    return { managed: false, outputPath: null };
  }
}

async function readMarker(bundle) {
  try {
    return markerOutputPath(await readFile(join(bundle, NIX_MANAGED_MARKER), "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { managed: false, outputPath: null };
    throw error;
  }
}

/** Describes whatever sits at the install path without following it. */
export async function inspectInstalledApp(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (stats.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (stats.isDirectory()) return { kind: "directory", ...(await readMarker(path)) };
  return { kind: "other" };
}

// The updater owns links into its profile or the store, and copies carrying the
// Nix marker. A plain Electron install or anything else stays untouched.
const OWNED_LINK =
  /(^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+|\/Paseo\/nix-update\/profile)\/Applications\/Paseo\.app\/?$/;

export function planAppInstall({ installed, activeOutputPath, activeMarker, busy }) {
  if (installed.kind === "directory" && installed.outputPath === activeOutputPath)
    return { action: "current" };
  const owned =
    installed.kind === "missing" ||
    (installed.kind === "symlink" && OWNED_LINK.test(installed.target)) ||
    (installed.kind === "directory" && installed.managed);
  if (!owned) return { action: "skip", reason: `${INSTALLED_APP} is not managed by the updater` };
  if (activeMarker.outputPath !== activeOutputPath)
    return { action: "skip", reason: "the active release predates installed app copies" };
  if (busy) return { action: "defer", reason: `Paseo is running from ${INSTALLED_APP}` };
  return { action: "install" };
}

/** Process ids whose executable lives inside the bundle (`ps -axww -o pid=,command=`). */
export function bundleProcesses(psOutput, bundle) {
  const prefix = `${bundle}/`;
  const pids = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2].startsWith(prefix)) pids.push(Number(match[1]));
  }
  return pids;
}

const processesInBundle = (bundle) =>
  bundleProcesses(run("/bin/ps", ["-axww", "-o", "pid=,command="]).stdout, bundle);

const ditto = (source, destination) => run("/usr/bin/ditto", [source, destination]);
// Store files are read-only; the copy must stay deletable by the next update.
// Mode bits are not part of the code signature.
export async function makeWritable(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) return;
  if (!(stats.mode & 0o200)) await chmod(path, stats.mode | 0o200);
  if (stats.isDirectory())
    for (const name of await readdir(path)) await makeWritable(join(path, name));
}

/**
 * Copies `source` beside `destination` and swaps it in. The old app is moved
 * aside first and restored if the new one cannot take its place, so the path
 * is never left empty. Only call this while nothing runs from `destination`.
 */
export async function installAppCopy(source, destination, { copy = ditto } = {}) {
  const parent = dirname(destination);
  const prefix = `.${basename(destination)}.staging-`;
  for (const name of await readdir(parent))
    if (name.startsWith(prefix)) {
      await makeWritable(join(parent, name));
      await rm(join(parent, name), { recursive: true, force: true });
    }
  const work = await mkdtemp(join(parent, prefix));
  const staged = join(work, basename(destination));
  const aside = join(work, "previous");
  try {
    await copy(source, staged);
    await makeWritable(staged);
    let moved = false;
    try {
      await rename(destination, aside);
      moved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(staged, destination);
    } catch (error) {
      if (moved) await rename(aside, destination);
      throw error;
    }
  } finally {
    await makeWritable(work);
    await rm(work, { recursive: true, force: true });
  }
}

// macOS launches sh.paseo.desktop for notification clicks and `open -b` from the
// highest registered bundle version. Store bundles are registered whenever one
// is opened by path, and fork semver restarted below the legacy 0.11.0 builds,
// so every store bundle except the one the app should launch is unregistered.
export function staleLaunchServicesBundles(dump, keepBundle) {
  const pattern =
    /^path:\s+(\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/\s]+\/Applications\/Paseo\.app) \(0x[0-9a-f]+\)$/gm;
  const stale = new Set();
  for (const [, bundle] of dump.matchAll(pattern)) if (bundle !== keepBundle) stale.add(bundle);
  return [...stale];
}

function syncLaunchServices(keepBundle) {
  try {
    run(LSREGISTER, ["-f", keepBundle]);
    for (const bundle of staleLaunchServicesBundles(run(LSREGISTER, ["-dump"]).stdout, keepBundle))
      run(LSREGISTER, ["-u", bundle]);
  } catch (error) {
    warn("Could not update LaunchServices registrations", error);
  }
}

// Minimal XML plist round-trip: `defaults export` emits plain elements without
// CDATA, so untouched nodes keep their exact bytes.
function parsePlistXml(xml) {
  const root = { open: "", children: [], close: "" };
  const stack = [root];
  for (const [token] of xml.matchAll(/<!--[\s\S]*?-->|<[?!][^>]*>|<[^>]+>|[^<]+/g)) {
    const top = stack.at(-1);
    const tag = /^<\/?([A-Za-z][\w-]*)/.exec(token)?.[1];
    if (!tag) top.children.push(token);
    else if (token.startsWith("</")) {
      assert.equal(top.tag, tag, "Unbalanced Dock preferences");
      top.close = token;
      stack.pop();
    } else {
      const node = { tag, open: token, children: [], close: "" };
      top.children.push(node);
      if (!token.endsWith("/>")) stack.push(node);
    }
  }
  assert.equal(stack.length, 1, "Unterminated Dock preferences");
  return root;
}

const serialize = (node) =>
  typeof node === "string" ? node : node.open + node.children.map(serialize).join("") + node.close;
const elements = (node) => node.children.filter((child) => typeof child !== "string");
const text = (node) => node.children.filter((child) => typeof child === "string").join("");

function dictEntry(dict, key) {
  if (dict?.tag !== "dict") return null;
  const items = elements(dict);
  for (let index = 0; index < items.length - 1; index += 2)
    if (items[index].tag === "key" && text(items[index]) === key) return items[index + 1];
  return null;
}

// Drops a node with the whitespace that precedes it so the output stays indented.
function removeNode(parent, node) {
  const index = parent.children.indexOf(node);
  const start = typeof parent.children[index - 1] === "string" ? index - 1 : index;
  parent.children.splice(start, index - start + 1);
}

export const INSTALLED_APP_URL = `file://${INSTALLED_APP}/`;
const MANAGED_TILE_URL =
  /^file:\/\/(\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+|\/.*\/Paseo\/nix-update\/profile)\/Applications\/Paseo\.app\/?$/;

/**
 * Points Dock tiles pinned to a store or profile bundle at the installed copy
 * and keeps one Paseo tile, in the position of the first.
 */
export function rewriteDockPlist(xml) {
  const root = parsePlistXml(xml);
  const top = elements(elements(root).find((node) => node.tag === "plist") ?? { children: [] })[0];
  const apps = dictEntry(top, "persistent-apps");
  if (apps?.tag !== "array") return { xml, changed: false };
  let kept = null;
  let changed = false;
  for (const tile of elements(apps)) {
    const data = dictEntry(tile, "tile-data");
    const url = dictEntry(dictEntry(data, "file-data"), "_CFURLString");
    const value = url?.tag === "string" ? text(url) : null;
    const managed = value !== null && MANAGED_TILE_URL.test(value);
    if (!managed && value !== INSTALLED_APP_URL) continue;
    if (kept) {
      removeNode(apps, tile);
      changed = true;
      continue;
    }
    kept = tile;
    if (!managed) continue;
    url.children = [INSTALLED_APP_URL];
    // The bookmark still resolves to the store bundle and wins over the URL.
    const book = dictEntry(data, "book");
    if (book) {
      const key = elements(data)[elements(data).indexOf(book) - 1];
      removeNode(data, book);
      removeNode(data, key);
    }
    changed = true;
  }
  return { xml: changed ? serialize(root) : xml, changed };
}

const dockAdapters = {
  exportDock: () => run("/usr/bin/defaults", ["export", "com.apple.dock", "-"]).stdout,
  importDock: (xml) => run("/usr/bin/defaults", ["import", "com.apple.dock", "-"], { input: xml }),
  restartDock: () => run("/usr/bin/killall", ["Dock"]),
};

/** One-time migration of store-pinned Dock tiles; reports whether it changed anything. */
export function migrateDockTiles(adapters = dockAdapters) {
  try {
    const { xml, changed } = rewriteDockPlist(adapters.exportDock());
    if (!changed) return false;
    adapters.importDock(xml);
    adapters.restartDock();
    return true;
  } catch (error) {
    warn("Could not update Dock tiles", error);
    return false;
  }
}

/**
 * Makes /Applications/Paseo.app the active release, keeps LaunchServices on the
 * bundle the app launches from, and repoints the Dock at it. Returns the bundle
 * to open.
 */
export async function syncDesktopApp(activeOutputPath, { waitForQuitMs = 0 } = {}) {
  const active = appBundle(activeOutputPath);
  let launch = active;
  let keep = active;
  try {
    const activeMarker = await readMarker(active);
    const plan = async (busy) =>
      planAppInstall({
        installed: await inspectInstalledApp(INSTALLED_APP),
        activeOutputPath,
        activeMarker,
        busy,
      });
    let decision = await plan(false);
    if (decision.action === "install") {
      const deadline = Date.now() + waitForQuitMs;
      let busy = processesInBundle(INSTALLED_APP).length > 0;
      while (busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        busy = processesInBundle(INSTALLED_APP).length > 0;
      }
      decision = await plan(busy);
    }
    if (decision.action === "install") {
      await installAppCopy(active, INSTALLED_APP);
      decision = await plan(false);
    }
    if (decision.reason)
      process.stderr.write(`Left ${INSTALLED_APP} unchanged: ${decision.reason}.\n`);
    // A deferred copy is still the app the user runs; the restart replaces it.
    if (decision.action === "current" || decision.action === "defer") {
      keep = INSTALLED_APP;
      migrateDockTiles();
    }
    if (decision.action === "current") launch = INSTALLED_APP;
  } catch (error) {
    warn(`Could not install ${INSTALLED_APP}`, error);
  }
  syncLaunchServices(keep);
  return launch;
}

/** Waits for a process to exit; returns false on timeout. */
export async function waitForExit(pid, timeoutMs, isAlive = processAlive) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Opens the installed copy, or execs the store executable when no copy matches. */
export function launchDesktopApp(bundle) {
  if (bundle === INSTALLED_APP) run("/usr/bin/open", [bundle]);
  else
    spawn(join(bundle, "Contents", "MacOS", "Paseo"), [], {
      detached: true,
      stdio: "ignore",
    }).unref();
}
