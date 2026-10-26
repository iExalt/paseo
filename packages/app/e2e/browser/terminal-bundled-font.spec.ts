import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

// U+F113 (Font Awesome), U+F0001 (nf-md, only in Nerd Fonts v3 builds) and U+EA60
// (codicon), as UTF-8 octal escapes so any printf can emit them.
const ICON_LINE = String.raw`\357\204\223 \363\260\200\201 \356\251\240`;

interface CellBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readIconCells(page: Page): Promise<{ fontFamily: string; cells: CellBox[] }> {
  return page.evaluate(() => {
    const term = (
      window as Window & {
        __paseoTerminal?: {
          options: { fontFamily?: string };
          _core: {
            _renderService: { dimensions: { css: { cell: { width: number; height: number } } } };
          };
        };
      }
    ).__paseoTerminal;
    const screen = document.querySelector<HTMLElement>(
      '[data-testid="terminal-surface"] .xterm-screen',
    );
    if (!term || !screen) {
      throw new Error("terminal not mounted");
    }
    const { width, height } = term._core._renderService.dimensions.css.cell;
    const origin = screen.getBoundingClientRect();
    // Icons sit at columns 0, 2 and 4 of the first row. Each crop spans two
    // cells so the overhanging ink is included.
    const cells = [0, 2, 4].map((col) => ({
      x: origin.x + col * width,
      y: origin.y,
      width: width * 1.5,
      height,
    }));
    return { fontFamily: term.options.fontFamily ?? "", cells };
  });
}

async function waitForBundledFont(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readIconCells(page)).fontFamily, { timeout: 15_000 })
    .toContain("MesloLGS NF");
}

async function printIconsAndCrop(page: Page, harness: TerminalE2EHarness): Promise<Buffer[]> {
  await harness.setupPrompt(page);
  const sentinel = `ICONS_${Date.now()}`;
  await harness
    .terminalSurface(page)
    .pressSequentially(`clear; printf '${ICON_LINE}\\n'; echo ${sentinel}\n`, { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes(`\n${sentinel}`), 10_000);
  await page.waitForTimeout(250);
  const { cells } = await readIconCells(page);
  return Promise.all(cells.map((clip) => page.screenshot({ clip })));
}

async function attachTerminalScreenshot(
  page: Page,
  harness: TerminalE2EHarness,
  path: string,
): Promise<void> {
  await harness.terminalSurface(page).screenshot({ path });
  await test.info().attach(path.split("/").pop()!, { path, contentType: "image/png" });
}

test.describe("Terminal bundled Nerd Font", () => {
  test.describe.configure({ timeout: 120_000 });

  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-font-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("draws Nerd Font icons once the bundled font loads", async ({ page }, testInfo) => {
    // Slow the font download so the terminal opens before it arrives.
    await page.route("**/fonts/meslolgs-nf/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await withTerminalInApp(page, harness, { name: "font-loaded" }, async () => {
      await waitForBundledFont(page);
      const crops = await printIconsAndCrop(page, harness);
      expect(crops[0]!.equals(crops[1]!)).toBe(false);
      expect(crops[1]!.equals(crops[2]!)).toBe(false);
      expect(crops[0]!.equals(crops[2]!)).toBe(false);
      await attachTerminalScreenshot(page, harness, testInfo.outputPath("icons-font-loaded.png"));
    });
  });
});
