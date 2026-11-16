import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function observe(roots: string[], changed = vi.fn(), debounceMs = 10) {
  const errors: unknown[] = [];
  const watch = watchSkillChanges(roots, changed, (err) => errors.push(err), debounceMs);
  cleanups.push(() => watch.close());
  return { watch, changed, errors };
}
async function mutation(observer: ReturnType<typeof observe>, change: () => Promise<unknown>) {
  const before = observer.changed.mock.calls.length;
  await change();
  await expect
    .poll(() => observer.changed.mock.calls.length, { timeout: 3000 })
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
  const changed = vi.fn();
  // One wide debounce window holds the removal and the recreation, so one reconcile sees both.
  const observer = observe([skills], changed, 200);
  await observer.watch.ready;
  const before = changed.mock.calls.length;
  await rm(skills, { recursive: true });
  await mkdir(skills);
  await expect.poll(() => changed.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(before);
  await mutation(observer, () => writeFile(join(skills, "SKILL.md"), "recreated"));
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
  await expect.poll(() => second.changed.mock.calls.length).toBeGreaterThan(0);
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
  const observer = observe([skills]);
  await observer.watch.ready;
  // Observe beyond the debounce interval so startup canaries cannot pass unnoticed.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(observer.changed).not.toHaveBeenCalled();
  expect(observer.errors).toEqual([]);
  await writeFile(file, "second");
  await expect.poll(() => observer.changed.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(observer.changed).toHaveBeenCalledTimes(1);
  expect(observer.errors).toEqual([]);
});
