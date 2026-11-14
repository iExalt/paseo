import { createWatcherLivenessCanary } from "../watcher-liveness-canary.js";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  filter?: string,
): SkillWatch {
  const key = JSON.stringify([directory, recursive]);
  let entry = watches.get(key);
  if (!entry) {
    const callbacks = new Set<(filename: string | null) => void>();
    const abort = new AbortController();
    const canary = createWatcherLivenessCanary(directory);
    const watcher = watch(directory, { recursive, persistent: false }, (_event, filename) => {
      const name = filename?.toString() ?? null;
      if (name) {
        const events = canary.filterEvents([{ path: resolve(directory, name), type: "update" }]);
        if (events.length === 0 || basename(name).startsWith(".paseo-watcher-canary-")) return;
      }
      for (const listener of callbacks) listener(name);
    });
    watcher.on("error", onError);
    const ready = canary.verify(abort.signal).catch((error) => {
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
    });
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

export function watchSkillChanges(
  roots: readonly string[],
  onChange: () => void | Promise<void>,
  onError: (error: unknown) => void,
  debounceMs = 150,
): SkillWatch {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscriptions: Array<() => void> = [];
  let preparing: Array<() => void> = [];
  let pending = Promise.resolve();
  const change = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending
        .then(async () => {
          if (closed) return;
          await reconcile();
          if (!closed) await onChange();
          return undefined;
        })
        .catch(onError);
    }, debounceMs);
    timer.unref();
  };
  async function reconcile() {
    const next: Array<() => void> = [];
    preparing = next;
    const readiness: Promise<void>[] = [];
    const observed = new Set<string>();
    const visited = new Set<string>();
    const add = (directory: string, recursive: boolean, filter?: string) => {
      if (closed) return;
      const key = JSON.stringify([directory, recursive, filter]);
      if (observed.has(key)) return;
      observed.add(key);
      try {
        const observation = observe(directory, recursive, change, onError, filter);
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
      add(parent, false, child);
    };
    // Recursive fs.watch does not consistently follow directory symlinks on all platforms.
    const links = async (directory: string): Promise<void> => {
      const target = await realpath(directory);
      if (visited.has(target)) return;
      visited.add(target);
      await parentWatch(target);
      add(target, true);
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const child = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            // Keep observing a dangling target's parent so later creation is visible.
            await parentWatch(resolve(dirname(child), await readlink(child)));
            const info = await stat(child).catch(() => null);
            if (info?.isDirectory()) await links(child);
            else if (info?.isFile()) {
              const fileTarget = await realpath(child);
              await parentWatch(fileTarget);
            }
          } else if (entry.isDirectory()) await walk(child);
        }
      };
      await walk(target);
    };
    for (const root of roots) {
      try {
        // A shallow parent watch also detects atomic directory replacement or later creation.
        await parentWatch(root);
        if ((await stat(root).catch(() => null))?.isDirectory()) await links(root);
      } catch (error) {
        if (!missing(error)) onError(error);
      }
    }
    await Promise.all(readiness);
    for (const unsubscribe of subscriptions) unsubscribe();
    if (closed) for (const unsubscribe of next) unsubscribe();
    subscriptions = closed ? [] : next;
    preparing = [];
  }
  const ready = reconcile().catch(onError);
  pending = ready;
  return {
    ready,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const unsubscribe of preparing) unsubscribe();
      subscriptions = [];
      preparing = [];
    },
  };
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
