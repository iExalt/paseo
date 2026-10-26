import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledTerminalFont, resetBundledTerminalFontForTest } from "./terminal-bundled-font";
import { TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

interface XtermProbe {
  rows: number;
  options: { fontFamily?: string };
  _core: { _renderService: { dimensions: { css: { cell: { height: number } } } } };
}

interface Mounted {
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  terminal: XtermProbe;
}

const mounted: Mounted[] = [];

function mountTerminal(): Mounted {
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;left:0;top:0;width:640px;height:400px;overflow:hidden";
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%";
  root.appendChild(host);
  document.body.appendChild(root);
  const runtime = new TerminalEmulatorRuntime();
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: 1_000,
    theme: { background: "#0b0b0b", foreground: "#e6e6e6", cursor: "#e6e6e6" },
  });
  const entry = { root, runtime, terminal: window.__paseoTerminal as unknown as XtermProbe };
  mounted.push(entry);
  return entry;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > 5_000) {
      throw new Error("Timed out waiting for the bundled terminal font");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function cellHeight(terminal: XtermProbe): number {
  return terminal._core._renderService.dimensions.css.cell.height;
}

beforeEach(() => {
  resetBundledTerminalFontForTest();
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.runtime.unmount();
    entry.root.remove();
  }
});

describe("bundled terminal font", () => {
  it("measures without the font while it loads, then switches and refits", async () => {
    const { terminal } = mountTerminal();
    expect(terminal.options.fontFamily).not.toMatch(/MesloLGS NF/);
    await waitFor(() => cellHeight(terminal) > 0);
    const fallbackHeight = cellHeight(terminal);
    const fallbackRows = terminal.rows;

    await waitFor(() => /MesloLGS NF/.test(terminal.options.fontFamily ?? ""));
    expect(document.fonts.check('13px "MesloLGS NF"', "\u{f0001}")).toBe(true);

    // Meslo's line height is 1.262 em; the usual fallbacks share its advance
    // width but are shorter, so height is what tells the fonts apart.
    await waitFor(() => cellHeight(terminal) !== fallbackHeight);
    // xterm rounds the 16.4 px line box up to whole pixels.
    expect(cellHeight(terminal)).toBe(Math.ceil((13 * (2001 + 583)) / 2048));
    expect(fallbackHeight).toBeLessThan(cellHeight(terminal));
    await waitFor(() => terminal.rows !== fallbackRows);
    expect(terminal.rows).toBe(Math.floor(400 / cellHeight(terminal)));
  });

  it("uses the font from the start once it has loaded", async () => {
    await expect(loadBundledTerminalFont()).resolves.toBe(true);
    const { terminal } = mountTerminal();
    expect(terminal.options.fontFamily).toMatch(/^'MesloLGS NF'/);
  });

  it("ignores a load that finishes after the terminal unmounts", async () => {
    const entry = mountTerminal();
    entry.runtime.unmount();
    await expect(loadBundledTerminalFont()).resolves.toBe(true);
    const { terminal } = mountTerminal();
    expect(terminal.options.fontFamily).toMatch(/^'MesloLGS NF'/);
  });
});
