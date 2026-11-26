import { createWatcherLivenessCanary } from "../watcher-liveness-canary.js";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  isAllowedSkillPath,
  isExcludedCursorPath,
  resolveCursorDiscoveryPath,
  resolveCursorSkillRoot,
  walkCursorSkillDirectories,
  type CursorSkillRoot,
} from "./cursor-skill-catalog.js";

/** Watch discovery directories, never a whole checkout or home directory recursively. */
export function skillRoots(config: { cwd: string; env?: NodeJS.ProcessEnv }): string[] {
  const env = { ...process.env, ...config.env };
  const home = env.HOME || homedir();
  const directories = [
    ".agents",
    ".agent",
    ".claude",
    ".codex",
    ".pi",
    ".omp",
    ".opencode",
    ".github",
    ".kiro",
    ".cursor",
    ".copilot",
    ".gemini",
    ".kimi",
    ".trae",
    ".muse",
  ];
  const configured = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    return value.startsWith("~/") ? join(home, value.slice(2)) : resolve(value);
  };
  const roots = new Set([
    ...directories.map((dir) => join(home, dir, "skills")),
    join(configured("CLAUDE_CONFIG_DIR", join(home, ".claude")), "skills"),
    join(configured("CODEX_HOME", join(home, ".codex")), "skills"),
    join(configured("PI_CODING_AGENT_DIR", join(home, ".pi", "agent")), "skills"),
    join(configured("OMP_AGENT_DIR", join(home, ".omp", "agent")), "skills"),
    join(configured("XDG_CONFIG_HOME", join(home, ".config")), "opencode", "skills"),
    join(home, ".gemini", "antigravity", "skills"),
    join(home, ".gemini", "antigravity-cli", "skills"),
    join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
  ]);
  for (let cwd = resolve(config.cwd); ; cwd = dirname(cwd)) {
    for (const dir of directories) roots.add(join(cwd, dir, "skills"));
    if (dirname(cwd) === cwd) break;
  }
  return [...roots];
}

export interface SkillWatch {
  ready: Promise<void>;
  close(): void;
}

/** Shared between sessions watching the same directory, including symlink targets. */
const watches = new Map<
  string,
  {
    watcher: FSWatcher;
    callbacks: Set<(filename: string | null) => void>;
    ready: Promise<void>;
    abort: AbortController;
  }
>();
function observe(
  directory: string,
  recursive: boolean,
  callback: () => void,
  onError: (error: unknown) => void,
  identity: string,
  filter?: string,
  probe = true,
): SkillWatch {
  // A directory recreated at the same path must not reuse the deleted one's watcher.
  const key = JSON.stringify([directory, recursive, identity, probe]);
  let entry = watches.get(key);
  if (!entry) {
    const callbacks = new Set<(filename: string | null) => void>();
    const abort = new AbortController();
    const canary = probe ? createWatcherLivenessCanary(directory) : null;
    const watcher = watch(directory, { recursive, persistent: false }, (_event, filename) => {
      const name = filename?.toString() ?? null;
      if (name) {
        const events = canary?.filterEvents([{ path: resolve(directory, name), type: "update" }]);
        if (events?.length === 0 || basename(name).startsWith(".paseo-watcher-canary-")) return;
      }
      for (const listener of callbacks) listener(name);
    });
    watcher.on("error", onError);
    const ready =
      canary?.verify(abort.signal).catch((error) => {
        // A read-only ancestor can be watched but cannot host a liveness probe.
        if (
          abort.signal.aborted ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error.code === "EACCES" || error.code === "EROFS"))
        )
          return;
        onError(error);
      }) ?? Promise.resolve();
    entry = { watcher, callbacks, ready, abort };
    watches.set(key, entry);
  }
  const listener = (filename: string | null) => {
    if (!filter || !filename || filename === filter) callback();
  };
  entry.callbacks.add(listener);
  let released = false;
  return {
    ready: entry.ready,
    close() {
      if (released) return;
      released = true;
      entry.callbacks.delete(listener);
      if (entry.callbacks.size === 0) {
        entry.abort.abort();
        entry.watcher.close();
        if (watches.get(key) === entry) watches.delete(key);
      }
    },
  };
}

function scheduleSkillReconciliation(reconcile: () => Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(() => void reconcile(), delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export function watchSkillChanges(
  roots: readonly string[] | (() => Promise<readonly CursorSkillRoot[]>),
  onChange: () => void | Promise<void>,
  onError: (error: unknown) => void,
  debounceMs = 150,
  schedule = scheduleSkillReconciliation,
): SkillWatch {
  let closed = false;
  let cancelDebounce: (() => void) | undefined;
  let subscriptions: Array<() => void> = [];
  let preparing: Array<() => void> = [];
  let pending = Promise.resolve();
  let catalog: string | undefined;
  const change = () => {
    if (closed) return;
    cancelDebounce?.();
    cancelDebounce = schedule(() => {
      pending = pending
        .then(async () => {
          if (closed) return;
          const next = await reconcile();
          // Claude Code rewrites sync bookkeeping in ~/.claude/skills every few seconds without
          // changing any skill; reporting those writes keeps slash menus reloading forever.
          if (closed || next === catalog) return undefined;
          await onChange();
          catalog = next;
          return undefined;
        })
        .catch(onError);
      return pending;
    }, debounceMs);
  };
  async function reconcile(): Promise<string> {
    const next: Array<() => void> = [];
    preparing = next;
    const readiness: Promise<void>[] = [];
    const entries: string[] = [];
    const observed = new Set<string>();
    const visited = new Set<string>();
    const add = async (directory: string, recursive: boolean, filter?: string, probe = true) => {
      if (closed) return;
      const key = JSON.stringify([directory, recursive, filter]);
      if (observed.has(key)) return;
      observed.add(key);
      try {
        // Filesystems reuse a deleted directory's inode at once; birth time tells them apart.
        const { dev, ino, birthtimeNs } = await stat(directory, { bigint: true });
        if (closed) return;
        const identity = `${dev}:${ino}:${birthtimeNs}`;
        if (filter === undefined) entries.push(`d ${directory} ${identity}`);
        const observation = observe(directory, recursive, change, onError, identity, filter, probe);
        next.push(observation.close);
        readiness.push(observation.ready);
      } catch (error) {
        if (!missing(error)) onError(error);
      }
    };
    const parentWatch = async (root: string) => {
      let parent = dirname(root);
      let child = basename(root);
      while (!(await stat(parent).catch(() => null))?.isDirectory()) {
        child = basename(parent);
        const ancestor = dirname(parent);
        if (ancestor === parent) break;
        parent = ancestor;
      }
      await add(parent, false, child);
    };
    // Watch physical directories directly: recursive fs.watch can report target canaries as symlink aliases.
    const links = async (directory: string): Promise<void> => {
      const target = await realpath(directory);
      if (visited.has(target)) return;
      visited.add(target);
      await parentWatch(target);
      const walk = async (dir: string): Promise<void> => {
        await add(dir, false);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const child = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            // Keep observing a dangling target's parent so later creation is visible.
            const linkTarget = await readlink(child);
            entries.push(`l ${child} ${linkTarget}`);
            await parentWatch(resolve(dirname(child), linkTarget));
            const info = await stat(child).catch(() => null);
            if (info?.isDirectory()) await links(child);
            else if (info?.isFile()) {
              const fileTarget = await realpath(child);
              await parentWatch(fileTarget);
              if (!entry.name.startsWith(".")) entries.push(`f ${child} ${await digest(child)}`);
            }
          } else if (entry.isDirectory()) await walk(child);
          else if (entry.isFile() && !entry.name.startsWith("."))
            entries.push(`f ${child} ${await digest(child)}`);
        }
      };
      await walk(target);
    };
    const scoped = async (source: CursorSkillRoot) => {
      // Watch lexical names for replacement and physical skill directories for edits.
      const traced = new Set<string>();
      const trace = async (path: string): Promise<void> => {
        if (traced.has(path) || isExcludedCursorPath(source, path)) return;
        traced.add(path);
        const lexicalParent = dirname(path);
        if (lexicalParent === path) return;
        const parent = await resolveCursorDiscoveryPath(source, lexicalParent);
        if (!parent) {
          await trace(lexicalParent);
          return;
        }
        const name = basename(path);
        const physical = join(parent, name);
        if (isExcludedCursorPath(source, physical)) return;
        await add(parent, false, name, false);
        const link = await readlink(physical).catch(() => null);
        if (link) await trace(resolve(parent, link));
      };
      const traceParents = async (path: string) => {
        for (
          let current = path;
          current !== source.boundary && dirname(current) !== current;
          current = dirname(current)
        ) {
          await trace(current);
        }
      };
      if (!isAllowedSkillPath(source, source.path)) return;
      await traceParents(source.path);
      for (const input of new Set(source.catalogInputs)) {
        await traceParents(input);
        const canonical = await resolveCursorDiscoveryPath(source, input);
        if (!canonical) continue;
        if (canonical !== input) await traceParents(canonical);
        const stamp = await lstat(canonical, { bigint: true }).catch(() => null);
        if (!stamp) continue;
        if (stamp.isDirectory()) await add(canonical, false, undefined, false);
        entries.push(
          ["input", input, canonical, stamp.dev, stamp.ino, stamp.mtimeNs, stamp.ctimeNs].join(" "),
        );
      }
      const root = await resolveCursorSkillRoot(source);
      if (!root) return;
      for await (const {
        path,
        canonical,
        hasSkill,
        links: skillLinks,
      } of walkCursorSkillDirectories(source, root)) {
        if (canonical !== path) {
          await trace(path);
          await trace(canonical);
        }
        await add(canonical, false, undefined, false);
        for (const link of skillLinks) await trace(link);
        if (!hasSkill) continue;
        const file = join(canonical, "SKILL.md");
        const stamp = await lstat(file, { bigint: true }).catch(() => null);
        if (stamp?.isFile()) {
          entries.push([path, file, stamp.dev, stamp.ino, stamp.mtimeNs, stamp.ctimeNs].join(" "));
        }
      }
    };
    if (typeof roots === "function") {
      for (const source of await roots()) {
        try {
          await scoped(source);
        } catch (error) {
          if (!missing(error)) onError(error);
        }
      }
    } else {
      for (const root of roots) {
        try {
          // A shallow parent watch also detects atomic directory replacement or later creation.
          await parentWatch(root);
          if ((await stat(root).catch(() => null))?.isDirectory()) await links(root);
        } catch (error) {
          if (!missing(error)) onError(error);
        }
      }
    }
    await Promise.all(readiness);
    for (const unsubscribe of subscriptions) unsubscribe();
    if (closed) for (const unsubscribe of next) unsubscribe();
    subscriptions = closed ? [] : next;
    preparing = [];
    return entries.sort().join("\n");
  }
  const ready = (async () => {
    try {
      catalog = await reconcile();
    } catch (error) {
      onError(error);
    }
  })();
  pending = ready;
  return {
    ready,
    close() {
      closed = true;
      cancelDebounce?.();
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const unsubscribe of preparing) unsubscribe();
      subscriptions = [];
      preparing = [];
    },
  };
}

/** Content hashes keyed by path, reused while the file's stat is unchanged. */
const digests = new Map<string, { stamp: string; digest: string }>();
const maxHashedBytes = 1024 * 1024;
/** Identifies a file's content; a rewrite with identical bytes keeps its digest. */
async function digest(path: string): Promise<string> {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = await stat(path, { bigint: true });
    const stamp = `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
    // Hashing large assets costs more than the rare extra refresh their edits cause.
    if (size > maxHashedBytes) return stamp;
    const cached = digests.get(path);
    if (cached?.stamp === stamp) return cached.digest;
    const value = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    digests.set(path, { stamp, digest: value });
    return value;
  } catch (error) {
    // An unreadable file must not stop the walk of the rest of its root.
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return `unreadable:${code}`;
  }
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
