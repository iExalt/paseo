import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { writeFile } from "node:fs/promises";
import type { Locator, TestInfo } from "@playwright/test";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { expect, test, type Page } from "../support/fixtures";

// "Toggle command center" recorded as a two-key sequence. Both platform
// bindings are overridden so the spec does not depend on the host OS.
const COMMAND_CENTER_SEQUENCE = {
  "command-center-toggle-cmd-k-mac": "Cmd+K J",
  "command-center-toggle-ctrl-k-non-mac": "Ctrl+K J",
};

const SEQUENCE_PREFIX = process.platform === "darwin" ? "Meta+K" : "Control+K";
const SEQUENCE_FINAL_KEY = "j";

/** Record the sequence in Settings → Keyboard shortcuts, through its storage. */
async function recordCommandCenterSequence(page: Page): Promise<void> {
  await page.addInitScript((overrides) => {
    localStorage.setItem("@paseo:keyboard-shortcut-overrides", JSON.stringify(overrides));
  }, COMMAND_CENTER_SEQUENCE);
}

/**
 * Resize the window and let the app render again, so the resize lands between
 * the two keys of the sequence rather than after them.
 */
async function resizeWindowAndSettle(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForFunction((expected) => window.innerWidth === expected, width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectCommandCenterOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("command-center-panel")).toBeVisible({ timeout: 30_000 });
}

test.describe("Multi-key shortcut sequences", () => {
  test("a recorded sequence opens the command center", async ({ page, withWorkspace }) => {
    await recordCommandCenterSequence(page);
    const workspace = await withWorkspace({ prefix: "shortcut-sequence-" });
    await workspace.navigateTo();

    // Plain browser uses Alt for the existing sidebar hold state.
    const modifier = "Alt";
    const searchHint = page
      .getByTestId("sidebar-search")
      .locator("..")
      .getByText(process.platform === "darwin" ? "⌘K" : "Ctrl+K", {
        exact: true,
      });
    await expect(searchHint).toBeHidden();
    await page.keyboard.down(modifier);
    try {
      await expect(searchHint).toBeVisible();
    } finally {
      await page.keyboard.up(modifier);
      await page.mouse.move(0, 0);
    }
    await expect(searchHint).toBeHidden();

    const otherWorkspace = await withWorkspace({ prefix: "shortcut-hint-other-" });
    const currentRow = page.getByTestId(
      new RegExp(`^sidebar-workspace-row-.*:${workspace.workspaceId}$`),
    );
    await currentRow.click({ button: "right" });
    const currentPin = page.getByTestId(
      new RegExp(`^sidebar-workspace-menu-pin-.*:${workspace.workspaceId}$`),
    );
    await expect(currentPin).toBeVisible();
    await expect(
      currentPin.getByText(process.platform === "darwin" ? "⇧⌘P" : "Ctrl+Shift+P", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const otherRow = page.getByTestId(
      new RegExp(`^sidebar-workspace-row-.*:${otherWorkspace.workspaceId}$`),
    );
    await otherRow.click({ button: "right" });
    const otherPin = page.getByTestId(
      new RegExp(`^sidebar-workspace-menu-pin-.*:${otherWorkspace.workspaceId}$`),
    );
    await expect(otherPin).toBeVisible();
    await expect(
      otherPin.getByText(process.platform === "darwin" ? "⇧⌘P" : "Ctrl+Shift+P", { exact: true }),
    ).toBeHidden();
    await page.keyboard.press("Escape");

    await page.getByTestId("sidebar-help").click();
    await expect(
      page.getByTestId("sidebar-help-shortcuts").getByText("?", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press(SEQUENCE_PREFIX);
    await page.keyboard.press(SEQUENCE_FINAL_KEY);

    await expectCommandCenterOpen(page);
  });

  test("a sequence completes when the window resizes between its keys", async ({
    page,
    withWorkspace,
  }) => {
    await recordCommandCenterSequence(page);
    const workspace = await withWorkspace({ prefix: "shortcut-sequence-resize-" });
    await workspace.navigateTo();

    await page.keyboard.press(SEQUENCE_PREFIX);
    await resizeWindowAndSettle(page, 1100);
    await page.keyboard.press(SEQUENCE_FINAL_KEY);

    await expectCommandCenterOpen(page);
  });
});

async function readShortcutContrast(locator: Locator) {
  return locator.evaluate((element) => {
    const rgba = (value: string) => {
      const values = value.match(/[\d.]+/g)!.map(Number);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const blend = (base: number[], fill: number[], opacity = 1) => {
      const alpha = fill[3] * opacity;
      return fill.slice(0, 3).map((value, index) => value * alpha + base[index] * (1 - alpha));
    };
    const ancestors: Element[] = [];
    for (let node = element.parentElement; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors)
      background = blend(background, rgba(getComputedStyle(node).backgroundColor));
    const fill = element.parentElement?.firstElementChild;
    if (fill && fill !== element) {
      const style = getComputedStyle(fill);
      background = blend(background, rgba(style.backgroundColor), Number(style.opacity));
    }
    const foreground = rgba(getComputedStyle(element).color).slice(0, 3);
    const luminance = (color: number[]) => {
      const channels = color
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foregroundLuminance = luminance(foreground),
      backgroundLuminance = luminance(background);
    return {
      foreground,
      background,
      dark: backgroundLuminance < 0.5,
      ratio:
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
    };
  });
}

test("shortcut badge contrast and developer chrome meet the capture contract", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "shortcut-contrast-" });
  await workspace.navigateTo();
  await page.evaluate(() => {
    const indicator = document.createElement("div");
    indicator.className = "__expo_fast_refresh";
    indicator.dataset.testid = "fast-refresh-capture-fixture";
    indicator.textContent = "Fast refresh";
    document.body.append(indicator);
  });
  const badge = page
    .getByTestId("sidebar-search")
    .locator("..")
    .getByText(process.platform === "darwin" ? "⌘K" : "Ctrl+K", { exact: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.keyboard.down("Alt");
    try {
      await expect(badge).toBeVisible();
      await expect
        .poll(async () => (await readShortcutContrast(badge)).dark)
        .toBe(theme === "dark");
      const metrics = await readShortcutContrast(badge);
      await writeFile(
        testInfo.outputPath(`shortcut-contrast-${theme}.json`),
        JSON.stringify(metrics, null, 2),
      );
      await page.screenshot({ path: testInfo.outputPath(`shortcut-contrast-${theme}.png`) });
      expect(metrics.ratio, JSON.stringify(metrics)).toBeGreaterThanOrEqual(4.5);
      await expect(page.getByTestId("fast-refresh-capture-fixture")).toHaveCount(1);
      await expect(page.getByTestId("fast-refresh-capture-fixture")).toBeHidden();
    } finally {
      await page.keyboard.up("Alt");
    }
    await expect(badge).toBeHidden();
  }
});
for (const variant of ["default", "long"] as const) {
  test(`held icon badges stay readable outside controls in light and dark (${variant})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (variant === "long")
      await page.addInitScript(() =>
        localStorage.setItem(
          "@paseo:keyboard-shortcut-overrides",
          JSON.stringify({
            "sidebar-toggle-right-ctrl-e-non-mac": "Ctrl+Shift+Alt+E J",
            "agent-new-ctrl-shift-o-non-mac": "Ctrl+Shift+Alt+O J",
            "settings-toggle-ctrl-comma-non-mac": "Ctrl+Shift+Alt+, J",
            "workspace-tab-new-ctrl-t-non-mac": "Ctrl+Shift+Alt+T J",
            "message-input-voice-toggle-ctrl-shift-d-non-mac": "Ctrl+Shift+Alt+D J",
          }),
        ),
      );
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "held-hints-",
      title: "Shortcut hints",
    });
    const other =
      variant === "default" ? await seedWorkspace({ repoPrefix: "hint-other-workspace-" }) : null;
    try {
      await openAgentRoute(page, agent);
      await expect(
        page.getByRole("button", { name: "Enable Voice mode", exact: true }),
      ).toBeVisible();
      const hintIds = [
        "menu-button-shortcut-hint",
        "workspace-explorer-toggle-shortcut-hint",
        "sidebar-add-project-shortcut-hint",
        "sidebar-settings-shortcut-hint",
        "workspace-new-tab-button-shortcut-hint",
        "composer-voice-shortcut-hint",
      ];
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.mouse.move(720, 400);
        await page.keyboard.down("Alt");
        try {
          for (const id of hintIds) await expect(page.getByTestId(id)).toBeVisible();
          if (variant === "long")
            await expect(page.getByTestId("workspace-new-tab-button-shortcut-hint")).toContainText(
              "J",
            );
          await expect(page.locator(".__expo_fast_refresh")).toBeHidden();
          await expect
            .poll(async () =>
              page.getByTestId(hintIds[0]).evaluate((element) => {
                const values = getComputedStyle(element)
                  .backgroundColor.match(/[\d.]+/g)!
                  .slice(0, 3)
                  .map(Number);
                return (values[0] + values[1] + values[2]) / 3 < 128;
              }),
            )
            .toBe(theme === "dark");
          await page.waitForFunction(() =>
            [
              ...document.querySelectorAll(
                '[data-testid$="-shortcut-hint"], [data-testid^="workspace-tab-index-hint-"]',
              ),
            ].every((element) => Number(getComputedStyle(element).opacity) === 1),
          );
          const metrics = await page.evaluate(() => {
            const box = (e: Element) => {
              const r = e.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const painted = (e: Element) => {
              for (let n: Element | null = e; n; n = n.parentElement) {
                const style = getComputedStyle(n);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0
                )
                  return false;
              }
              const r = box(e);
              return r.width > 0 && r.height > 0;
            };
            const visibleControl = (element: Element) => {
              if (!painted(element)) return false;
              const rect = box(element);
              return (
                rect.x + rect.width > 0 &&
                rect.y + rect.height > 0 &&
                rect.x < innerWidth &&
                rect.y < innerHeight
              );
            };
            const area = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
              Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
              Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
            const hints = [
              ...document.querySelectorAll(
                '[data-testid$="-shortcut-hint"], [data-testid^="workspace-tab-index-hint-"], [data-testid^="workspace-tab-close-hint-"], [data-testid^="sidebar-workspace-archive-hint-"]',
              ),
            ].filter(painted);
            const controls = [
              ...document.querySelectorAll(
                'button,[role="button"],input,textarea,[role="textbox"],a[href]',
              ),
            ].filter(visibleControl);
            const overlaps = [];
            const covered = [];
            const clipped = [];
            const contrast = [];
            const rgb = (value: string) =>
              value
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number);
            const lum = (color: number[]) =>
              color
                .map((c) => c / 255)
                .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
                .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
            for (let i = 0; i < hints.length; i++) {
              const hint = hints[i],
                rect = box(hint),
                id = hint.getAttribute("data-testid");
              if (
                rect.x < -0.5 ||
                rect.y < -0.5 ||
                rect.x + rect.width > innerWidth + 0.5 ||
                rect.y + rect.height > innerHeight + 0.5
              )
                clipped.push(id);
              for (let j = i + 1; j < hints.length; j++)
                if (area(rect, box(hints[j])) > 0.5)
                  overlaps.push([id, hints[j].getAttribute("data-testid")]);
              for (const control of controls)
                if (area(rect, box(control)) > 0.5)
                  covered.push([
                    id,
                    control.getAttribute("data-testid") ??
                      control.getAttribute("aria-label") ??
                      control.tagName,
                  ]);
              for (const text of [...hint.querySelectorAll("*")].filter(
                (e) => e.children.length === 0 && e.textContent?.trim(),
              )) {
                const fg = rgb(getComputedStyle(text).color),
                  base = rgb(getComputedStyle(hint).backgroundColor);
                const background = text.parentElement?.firstElementChild;
                let bg = base;
                if (background && background !== text) {
                  const style = getComputedStyle(background),
                    fill = rgb(style.backgroundColor),
                    alpha = Number(style.opacity);
                  bg = fill.map((c, k) => c * alpha + base[k] * (1 - alpha));
                }
                const l1 = lum(fg),
                  l2 = lum(bg);
                contrast.push({
                  id,
                  text: text.textContent,
                  ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
                });
              }
            }
            return {
              hints: hints.map((e) =>
                Object.assign(box(e), {
                  id: e.getAttribute("data-testid"),
                  text: e.textContent,
                }),
              ),
              controls: controls.length,
              overlaps,
              covered,
              clipped,
              contrast,
            };
          });
          await writeFile(
            testInfo.outputPath(`held-hints-${theme}.json`),
            JSON.stringify(metrics, null, 2),
          );
          await testInfo.attach(`held-hints-${theme}.json`, {
            body: JSON.stringify(metrics, null, 2),
            contentType: "application/json",
          });
          await page.screenshot({ path: testInfo.outputPath(`held-hints-${theme}.png`) });
          expect(metrics.hints.length).toBeGreaterThanOrEqual(hintIds.length);
          expect(metrics.controls).toBeGreaterThan(0);
          expect(metrics.overlaps).toEqual([]);
          expect(metrics.covered).toEqual([]);
          expect(metrics.clipped).toEqual([]);
          expect(metrics.contrast.length).toBeGreaterThan(0);
          for (const sample of metrics.contrast)
            expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
        } catch (error) {
          await page.screenshot({
            path: testInfo.outputPath(`held-hints-${theme}-failure-before-release.png`),
          });
          throw error;
        } finally {
          await page.keyboard.up("Alt");
        }
        for (const id of hintIds) await expect(page.getByTestId(id)).toBeHidden();
      }
      if (other) await expectHintOwnership(page, agent, other, testInfo);
    } catch (error) {
      await page.screenshot({
        path: testInfo.outputPath("held-hints-ownership-failure-before-cleanup.png"),
      });
      throw error;
    } finally {
      await other?.cleanup();
      await agent.cleanup();
    }
  });
}

async function expectHintOwnership(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  other: Awaited<ReturnType<typeof seedWorkspace>>,
  testInfo: TestInfo,
) {
  const main = page.getByTestId("workspace-pane-main");
  const ids = [agent.agentId];
  for (let index = 1; index < 16; index++) {
    const next = await agent.client.createAgent({
      provider: "mock",
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      title: `Shortcut tab ${index} with a long ownership title`,
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    ids.push(next.id);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const explorer = await ensureExplorerSidebar(page);
  await expect(main.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(16);
  const orderedTabs = await main
    .locator('[data-testid^="workspace-tab-agent_"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        element.getAttribute("data-testid")!.slice("workspace-tab-".length),
      ),
    );
  expect(orderedTabs).toHaveLength(16);
  const first = `workspace-tab-index-hint-${orderedTabs[0]}`;
  const last = `workspace-tab-index-hint-${orderedTabs[8]}`;
  const scroll = main.getByTestId("workspace-tabs-scroll");
  await main.getByTestId(`workspace-tab-${orderedTabs[0]}`).click();
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await page.keyboard.down("Alt");
  try {
    await scroll.evaluate((element) => element.scrollTo({ left: 0 }));
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
    const scrollGeometry = await scroll.evaluate((element) => ({
      left: element.scrollLeft,
      width: element.clientWidth,
      total: element.scrollWidth,
      rect: element.getBoundingClientRect().toJSON(),
    }));
    const lastTab = await main
      .getByTestId(`workspace-tab-agent_${ids[ids.length - 1]}`)
      .boundingBox();
    await writeFile(
      testInfo.outputPath("held-tabs-scroll-geometry.json"),
      JSON.stringify({ scrollGeometry, lastTab, orderedTabs }, null, 2),
    );
    await expect(page.getByTestId(first)).toBeVisible();
    await expect(page.getByTestId(`workspace-tab-close-hint-${orderedTabs[0]}`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("held-tabs-scroll-start.png") });
    await main.getByTestId(`workspace-tab-${orderedTabs[8]}`).scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const firstTab = await main.getByTestId(`workspace-tab-${orderedTabs[0]}`).boundingBox();
        const rail = await scroll.boundingBox();
        return firstTab!.x + firstTab!.width / 2 < rail!.x;
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const tab = await main.getByTestId(`workspace-tab-${orderedTabs[8]}`).boundingBox();
        const rail = await scroll.boundingBox();
        const center = tab!.x + tab!.width / 2;
        return center >= rail!.x && center <= rail!.x + rail!.width;
      })
      .toBe(true);
    await expect(page.getByTestId(first)).toHaveCount(0);
    await expect(page.getByTestId(last)).toBeVisible();
    await expect(page.getByTestId("workspace-tab-index-hint-files")).toHaveCount(0);
    await expect(page.getByTestId(`workspace-tab-close-hint-${orderedTabs[0]}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("held-tabs-center-focused.png") });
  } finally {
    await page.keyboard.up("Alt");
  }
  await explorer.getByTestId("workspace-tab-files").click();
  await page.keyboard.down("Alt");
  try {
    // Explorer view selection preserves workspace focus by contract.
    await expect(page.getByTestId("workspace-tab-index-hint-files")).toHaveCount(0);
    await expect(page.getByTestId(last)).toBeVisible();
    await expect(page.getByTestId(`workspace-tab-close-hint-${orderedTabs[0]}`)).toHaveCount(0);
    const hint = await page.getByTestId("workspace-new-tab-button-shortcut-hint").boundingBox();
    const owner = await main.boundingBox();
    expect(hint).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(hint!.x).toBeGreaterThanOrEqual(owner!.x);
    expect(hint!.x + hint!.width).toBeLessThanOrEqual(owner!.x + owner!.width);
    await page.screenshot({ path: testInfo.outputPath("held-tabs-explorer-preserves-focus.png") });
  } finally {
    await page.keyboard.up("Alt");
  }
  await page.setViewportSize({ width: 1600, height: 900 });
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  const split = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId("workspace-new-tab-panel") });
  await expect(split).toHaveCount(1);
  await page.keyboard.down("Alt");
  try {
    // The new split owns its New-tab placeholder and shortcut target.
    await expect(page.getByTestId("workspace-new-tab-button-shortcut-hint")).toBeVisible();
    await expect(page.getByTestId(last)).toHaveCount(0);
    await expect(page.getByTestId("workspace-tab-index-hint-files")).toHaveCount(0);
    const hint = await page.getByTestId("workspace-new-tab-button-shortcut-hint").boundingBox();
    const owner = await split.boundingBox();
    expect(hint).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(hint!.x).toBeGreaterThanOrEqual(owner!.x);
    expect(hint!.x + hint!.width).toBeLessThanOrEqual(owner!.x + owner!.width);
    await page.screenshot({ path: testInfo.outputPath("held-tabs-real-split-focused.png") });
  } finally {
    await page.keyboard.up("Alt");
  }
  await main.getByTestId(`workspace-tab-${orderedTabs[8]}`).click();
  await page.keyboard.down("Alt");
  try {
    await expect(page.getByTestId(last)).toBeVisible();
    const hint = await page.getByTestId("workspace-new-tab-button-shortcut-hint").boundingBox();
    const owner = await main.boundingBox();
    expect(hint).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(hint!.x).toBeGreaterThanOrEqual(owner!.x);
    expect(hint!.x + hint!.width).toBeLessThanOrEqual(owner!.x + owner!.width);
    await expect(page.getByTestId(`workspace-tab-close-hint-${orderedTabs[8]}`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("held-tabs-real-main-focused.png") });
  } finally {
    await page.keyboard.up("Alt");
  }
  const currentKey = `${getServerId()}:${agent.workspaceId}`;
  const otherKey = `${getServerId()}:${other.workspaceId}`;
  for (const key of [currentKey, otherKey]) {
    const control = page.getByTestId(`sidebar-workspace-archive-button-${key}`);
    await page.getByTestId(`sidebar-workspace-row-${key}`).hover();
    await expect(control).toBeVisible();
    await page.keyboard.down("Alt");
    try {
      await expect(control).toHaveCount(0);
      await expect(page.getByTestId(`sidebar-workspace-archive-hint-${key}`)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(
          `held-archive-numeric-slot-${key === currentKey ? "current" : "other"}.png`,
        ),
      });
    } finally {
      await page.keyboard.up("Alt");
    }
    await expect(control).toBeVisible();
  }
}
