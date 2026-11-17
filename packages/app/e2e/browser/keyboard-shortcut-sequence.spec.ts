import { writeFile } from "node:fs/promises";
import type { Locator } from "@playwright/test";
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

test("shortcut badges meet contrast requirements in light and dark themes", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "shortcut-contrast-" });
  await workspace.navigateTo();
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
    } finally {
      await page.keyboard.up("Alt");
    }
    await expect(badge).toBeHidden();
  }
});
