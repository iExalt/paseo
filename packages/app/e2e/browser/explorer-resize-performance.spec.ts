import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";

interface DragMeasurement {
  observer: MutationObserver;
  stylesheetMutations: number;
  cssomMutations: number;
  restore: () => void;
}

declare global {
  interface Window {
    __PASEO_EXPLORER_DRAG_MEASUREMENT__?: DragMeasurement;
  }
}

async function waitForResizePaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function beginResizeMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stylesheet = document.getElementById("unistyles-web");
    if (!stylesheet) throw new Error("Shared stylesheet is missing");
    globalThis.__PASEO_RESET_RENDER_PROFILE__!();
    const sheet = (stylesheet as HTMLStyleElement).sheet;
    if (!sheet) throw new Error("Shared CSSStyleSheet is missing");
    const insertRule = CSSStyleSheet.prototype.insertRule;
    const deleteRule = CSSStyleSheet.prototype.deleteRule;
    const groupInsertRule = CSSGroupingRule.prototype.insertRule;
    const groupDeleteRule = CSSGroupingRule.prototype.deleteRule;
    const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText");
    if (!cssText?.set) throw new Error("CSSStyleDeclaration.cssText setter is missing");
    const restore = () => {
      CSSStyleSheet.prototype.insertRule = insertRule;
      CSSStyleSheet.prototype.deleteRule = deleteRule;
      CSSGroupingRule.prototype.insertRule = groupInsertRule;
      CSSGroupingRule.prototype.deleteRule = groupDeleteRule;
      Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", cssText);
    };
    const measurement: DragMeasurement = {
      stylesheetMutations: 0,
      cssomMutations: 0,
      restore,
      observer: new MutationObserver((records) => {
        measurement.stylesheetMutations += records.length;
      }),
    };
    let fixtureIndex: number | undefined;
    try {
      CSSStyleSheet.prototype.insertRule = function (...args) {
        if (this === sheet) measurement.cssomMutations++;
        return insertRule.apply(this, args);
      };
      CSSStyleSheet.prototype.deleteRule = function (...args) {
        if (this === sheet) measurement.cssomMutations++;
        return deleteRule.apply(this, args);
      };
      CSSGroupingRule.prototype.insertRule = function (...args) {
        if (this.parentStyleSheet === sheet) measurement.cssomMutations++;
        return groupInsertRule.apply(this, args);
      };
      CSSGroupingRule.prototype.deleteRule = function (...args) {
        if (this.parentStyleSheet === sheet) measurement.cssomMutations++;
        return groupDeleteRule.apply(this, args);
      };
      Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", {
        ...cssText,
        set(value: string) {
          if (this.parentRule?.parentStyleSheet === sheet) measurement.cssomMutations++;
          cssText.set!.call(this, value);
        },
      });
      measurement.observer.observe(stylesheet, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      fixtureIndex = sheet.insertRule("@media all {}", sheet.cssRules.length);
      const group = sheet.cssRules[fixtureIndex] as CSSGroupingRule;
      const ruleIndex = group.insertRule(":not(*) { color: red; }", group.cssRules.length);
      (group.cssRules[ruleIndex] as CSSStyleRule).style.cssText = "color: blue;";
      group.deleteRule(ruleIndex);
      sheet.deleteRule(fixtureIndex);
      fixtureIndex = undefined;
      if (measurement.cssomMutations !== 5) throw new Error("CSSOM measurement is incomplete");
      measurement.cssomMutations = 0;
      measurement.observer.takeRecords();
      window.__PASEO_EXPLORER_DRAG_MEASUREMENT__ = measurement;
    } catch (error) {
      try {
        if (fixtureIndex !== undefined) sheet.deleteRule(fixtureIndex);
      } finally {
        measurement.observer.disconnect();
        restore();
      }
      throw error;
    }
  });
}

async function previewExplorerResize(page: Page, distance: number) {
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Explorer resize handle is missing");
  const before = (await explorer.boundingBox())!.width;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  let during: number;
  let measurement: { stylesheetMutations: number; cssomMutations: number; paneRenders: number };
  try {
    await waitForResizePaint(page);
    await beginResizeMeasurement(page);
    for (let move = 1; move <= 20; move++) {
      await page.mouse.move(x + (distance * move) / 20, y);
      await waitForResizePaint(page);
    }
    during = (await explorer.boundingBox())!.width;
    measurement = await page.evaluate(() => {
      const state = window.__PASEO_EXPLORER_DRAG_MEASUREMENT__!;
      state.stylesheetMutations += state.observer.takeRecords().length;
      return {
        stylesheetMutations: state.stylesheetMutations,
        cssomMutations: state.cssomMutations,
        paneRenders: Object.entries(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {})
          .filter(([id]) => id.startsWith("SplitPaneView:"))
          .reduce((sum, [, reasons]) => sum + (reasons.render ?? 0), 0),
      };
    });
  } finally {
    try {
      await page.evaluate(() => {
        const state = window.__PASEO_EXPLORER_DRAG_MEASUREMENT__;
        state?.observer.disconnect();
        state?.restore();
        delete window.__PASEO_EXPLORER_DRAG_MEASUREMENT__;
      });
    } finally {
      await page.mouse.up();
    }
  }
  await waitForResizePaint(page);
  const after = (await explorer.boundingBox())!.width;
  expect(during).toBeCloseTo(before - distance, 0);
  expect(after).toBeCloseTo(during, 0);
  return { ...measurement, width: after };
}

async function expectExplorerWidthSurvivesReload(page: Page, width: number): Promise<void> {
  await page.reload();
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible();
  await expect.poll(async () => (await explorer.boundingBox())?.width).toBeCloseTo(width, 0);
}

test("Explorer drag previews without rerendering panes or rewriting the shared stylesheet", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    globalThis.__PASEO_RENDER_PROFILE_ENABLED__ = true;
  });
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
  // Verify that direct pane renders are being counted before resetting them.
  expect(
    await page.evaluate(() =>
      Object.keys(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {}).some((id) =>
        id.startsWith("SplitPaneView:"),
      ),
    ),
  ).toBe(true);
  const grown = await previewExplorerResize(page, -100);
  const shrunk = await previewExplorerResize(page, 50);
  expect(grown.stylesheetMutations).toBe(0);
  expect(grown.cssomMutations).toBe(0);
  expect(grown.paneRenders).toBe(0);
  expect(shrunk.stylesheetMutations).toBe(0);
  expect(shrunk.cssomMutations).toBe(0);
  expect(shrunk.paneRenders).toBe(0);
  await expectExplorerWidthSurvivesReload(page, shrunk.width);
});
