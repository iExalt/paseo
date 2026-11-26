import { cursorSkillRoots } from "./cursor-skill-catalog.js";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { watchSkillChanges, skillRoots } from "./skill-catalog-watch.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-skills-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function observe(
  roots: Parameters<typeof watchSkillChanges>[0],
  changed = vi.fn(),
  schedule?: Parameters<typeof watchSkillChanges>[4],
) {
  const errors: unknown[] = [];
  const watch = watchSkillChanges(roots, changed, (err) => errors.push(err), 10, schedule);
  cleanups.push(() => watch.close());
  return { watch, changed, errors };
}
function debounceControl() {
  let pending: (() => Promise<void>) | undefined;
  return {
    schedule(reconcile: () => Promise<void>) {
      pending = reconcile;
      return () => {
        if (pending === reconcile) pending = undefined;
      };
    },
    async flush() {
      const reconcile = pending;
      pending = undefined;
      await reconcile?.();
    },
    async waitForEvent() {
      await expect.poll(() => pending !== undefined, { timeout: 15_000 }).toBe(true);
    },
  };
}

async function replaceAtomically(path: string, content: string) {
  // Keep the temporary name outside the visible catalog, like a sync client.
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function mutation(observer: ReturnType<typeof observe>, change: () => Promise<unknown>) {
  const before = observer.changed.mock.calls.length;
  await change();
  await expect
    .poll(() => observer.changed.mock.calls.length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  expect(observer.errors).toEqual([]);
}

test("watches creation, content edits, atomic saves, removal and recreated roots", async () => {
  const root = await fixture();
  const skills = join(root, "config", "skills");
  const observer = observe([skills]);
  await observer.watch.ready;
  await mutation(observer, () => mkdir(join(skills, "test"), { recursive: true }));
  const file = join(skills, "test", "SKILL.md");
  await mutation(observer, () => writeFile(file, "first"));
  await mutation(observer, () => writeFile(file, "second"));
  await writeFile(join(skills, "test", "replacement"), "third");
  await mutation(observer, () => rename(join(skills, "test", "replacement"), file));
  await mutation(observer, () => rm(skills, { recursive: true }));
  await mutation(observer, () => mkdir(skills));
  await mutation(observer, () => writeFile(join(skills, "SKILL.md"), "recreated"));
});

test("watches a directory recreated within one debounce window", async () => {
  const root = await fixture();
  const skills = join(root, "skills");
  await mkdir(skills);
  const debounce = debounceControl();
  const observer = observe([skills], vi.fn(), debounce.schedule);
  await observer.watch.ready;

  await rm(skills, { recursive: true });
  await debounce.waitForEvent();
  await mkdir(skills);
  // Keep the first event pending until the directory exists again.
  await debounce.flush();
  expect(observer.changed).toHaveBeenCalledTimes(1);
  await replaceAtomically(join(skills, "SKILL.md"), "recreated");
  await debounce.waitForEvent();
  await debounce.flush();
  expect(observer.changed).toHaveBeenCalledTimes(2);
  expect(observer.errors).toEqual([]);
});

test("follows symlink targets and shares observations until the last subscriber closes", async () => {
  const root = await fixture();
  const skills = join(root, "skills");
  const target = join(root, "elsewhere");
  await mkdir(skills);
  await mkdir(target);
  await symlink(target, join(skills, "linked"), "dir");
  const first = observe([skills]);
  const second = observe([skills]);
  await Promise.all([first.watch.ready, second.watch.ready]);
  const file = join(target, "SKILL.md");
  await mutation(first, () => writeFile(file, "first"));
  await expect.poll(() => second.changed.mock.calls.length, { timeout: 15_000 }).toBeGreaterThan(0);
  first.watch.close();
  first.changed.mockClear();
  await mutation(second, () => writeFile(file, "second"));
  expect(first.changed).not.toHaveBeenCalled();
  await mutation(second, () => rm(target, { recursive: true }));
  await mutation(second, () => mkdir(target));
  await mutation(second, () => writeFile(file, "recreated"));
  await mutation(second, () => writeFile(file, "edited after recreation"));
});

test("closes while asynchronous setup is still running", async () => {
  const root = await fixture();
  const observer = observe([root]);
  observer.watch.close();
  await observer.watch.ready;
  await writeFile(join(root, "SKILL.md"), "after close");
  expect(observer.changed).not.toHaveBeenCalled();
});

test("includes overridden homes and ancestor project skill directories", () => {
  const roots = skillRoots({
    cwd: "/work/repo/subdir",
    env: { HOME: "/test", CODEX_HOME: "/custom" },
  });
  expect(roots).toContain("/custom/skills");
  expect(roots).toContain("/test/.agents/skills");
  expect(roots).toContain("/test/.copilot/skills");
  expect(roots).toContain("/test/.gemini/antigravity/skills");
  expect(roots).toContain("/work/repo/.claude/skills");
});

test("watches linked skill files and initially missing symlink targets", async () => {
  const root = await fixture();
  const skills = join(root, "skills");
  const target = join(root, "target");
  await mkdir(skills);
  await symlink(target, join(skills, "linked"), "dir");
  const observer = observe([skills]);
  await observer.watch.ready;
  await mutation(observer, () => mkdir(target));
  await mutation(observer, () => writeFile(join(target, "SKILL.md"), "created"));
  const source = join(root, "instructions.md");
  await writeFile(source, "first");
  await mutation(observer, () => symlink(source, join(skills, "SKILL.md"), "file"));
  await mutation(observer, () => writeFile(source, "second"));
  await mutation(observer, () => writeFile(source, "third"));
});

test("ignores canaries through symlinked skill directories but refreshes once for a real edit", async () => {
  const root = await fixture();
  const skills = join(root, "skills");
  const target = join(root, "physical", "iExalt");
  const nested = join(target, "nested");
  await mkdir(skills);
  await mkdir(nested, { recursive: true });
  const file = join(nested, "SKILL.md");
  await writeFile(file, "first");
  await symlink(target, join(skills, "iExalt"), "dir");
  const debounce = debounceControl();
  const observer = observe([skills], vi.fn(), debounce.schedule);
  await observer.watch.ready;
  // Readiness requires the initial liveness canaries to have made a round trip.
  await debounce.flush();
  expect(observer.changed).not.toHaveBeenCalled();
  expect(observer.errors).toEqual([]);

  await replaceAtomically(file, "second");
  await debounce.waitForEvent();
  await debounce.flush();
  // Force another delivery with the same catalog to cover duplicate refreshes.
  await replaceAtomically(file, "second");
  await debounce.waitForEvent();
  await debounce.flush();
  expect(observer.changed).toHaveBeenCalledTimes(1);
  expect(observer.errors).toEqual([]);
});

test("ignores rewrites that leave every skill unchanged", async () => {
  const root = await fixture();
  const skills = join(root, "skills");
  // Claude Code's synced-skill rounds rewrite these files every few seconds.
  const bucket = join(skills, "synced", "bucket");
  await mkdir(join(bucket, "pdf"), { recursive: true });
  const file = join(bucket, "pdf", "SKILL.md");
  await writeFile(file, "first");
  await writeFile(join(bucket, "manifest.json"), "{}");
  const debounce = debounceControl();
  const observer = observe([skills], vi.fn(), debounce.schedule);
  await observer.watch.ready;
  for (const round of ["one", "two", "three"]) {
    await replaceAtomically(join(bucket, ".last-complete-round"), round);
    await replaceAtomically(join(bucket, "manifest.json"), "{}");
    await replaceAtomically(file, "first");
    await debounce.waitForEvent();
    await debounce.flush();
    expect(observer.changed).not.toHaveBeenCalled();
  }
  await replaceAtomically(file, "second");
  await debounce.waitForEvent();
  await debounce.flush();
  expect(observer.changed).toHaveBeenCalledTimes(1);
  expect(observer.errors).toEqual([]);
});

test("refreshes a scoped catalog through authorized root links and their replacement", async () => {
  const boundary = await realpath(await fixture());
  const outside = await realpath(await fixture());
  const target = join(boundary, "physical");
  const alias = join(boundary, "skills");
  const file = join(target, "selected", "SKILL.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "first");
  await symlink(target, alias, "junction");
  const observer = observe(async () => [{ path: alias, boundary, scope: "workspace" }]);
  await observer.watch.ready;

  await mutation(observer, () => writeFile(file, "edited"));
  await mutation(observer, () => rm(target, { recursive: true }));
  const before = observer.changed.mock.calls.length;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "restored");
  await expect
    .poll(() => observer.changed.mock.calls.length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  await mutation(observer, async () => {
    await rm(alias);
    await symlink(outside, alias, "junction");
  });
  await mutation(observer, async () => {
    await rm(alias);
    await symlink(target, alias, "junction");
  });
  await mutation(observer, () => writeFile(file, "edited after reapproval"));
});

test("refreshes a scoped catalog when a nested link target outside the root changes or is replaced", async () => {
  const boundary = await realpath(await fixture());
  const root = join(boundary, "skills");
  const parent = join(root, "nested");
  const hidden = await realpath(await fixture());
  const target = join(hidden, "target");
  const replacement = join(hidden, "replacement");
  await mkdir(target, { recursive: true });
  await mkdir(replacement);
  await writeFile(join(target, "SKILL.md"), "original");
  await writeFile(join(replacement, "SKILL.md"), "replacement");
  await mkdir(parent, { recursive: true });
  await symlink(target, join(parent, "visible"), "junction");
  const observer = observe(async () => [{ path: root, boundary, scope: "workspace" }]);
  await observer.watch.ready;

  await mutation(observer, () => writeFile(join(target, "SKILL.md"), "edited"));
  await mutation(observer, async () => {
    await rename(target, join(hidden, "displaced"));
    await rename(replacement, target);
  });
});

test("refreshes a scoped catalog when Codex config or the active plugin installation changes", async () => {
  const home = await realpath(await fixture());
  const codex = join(home, ".codex");
  const config = join(codex, "config.toml");
  await mkdir(codex);
  vi.stubEnv("CODEX_HOME", codex);
  const observer = observe(() => cursorSkillRoots({ cwd: home }, undefined, home));
  try {
    await observer.watch.ready;
    await mutation(observer, () => writeFile(config, '[plugins."demo@fixture"]\n'));
    const root = join(codex, "plugins", "cache", "fixture", "demo", "1.0.0");
    const manifest = join(root, ".codex-plugin", "plugin.json");
    await mutation(observer, async () => {
      await mkdir(dirname(manifest), { recursive: true });
      await writeFile(manifest, '{"name":"Demo"}');
    });
    await mutation(observer, async () => {
      await rename(dirname(manifest), join(root, "replaced-manifest"));
      await mkdir(dirname(manifest));
      await writeFile(manifest, '{"name":"Replacement"}');
    });
    await mutation(observer, () => writeFile(manifest, '{"name":"Renamed"}'));
    const cache = join(codex, "plugins", "cache");
    const firstCache = join(home, "first-cache");
    const secondCache = join(home, "second-cache");
    const secondManifest = join(
      secondCache,
      "fixture",
      "demo",
      "1.0.0",
      ".codex-plugin",
      "plugin.json",
    );
    await mkdir(dirname(secondManifest), { recursive: true });
    await writeFile(secondManifest, '{"name":"Second cache"}');
    await mutation(observer, async () => {
      await rename(cache, firstCache);
      await symlink(firstCache, cache, "junction");
    });
    await mutation(observer, async () => {
      await rm(cache);
      await symlink(secondCache, cache, "junction");
    });
    await mutation(observer, () => writeFile(secondManifest, '{"name":"Renamed in second cache"}'));
    await mutation(observer, () =>
      writeFile(config, '[plugins."demo@fixture"]\nenabled = false\n'),
    );
    expect(observer.errors).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});
