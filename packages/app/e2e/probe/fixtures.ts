import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { test as base, expect, type ConsoleMessage } from "@playwright/test";
import {
  fakeDesktopScenario,
  installFakeDesktopBridge,
  type FakeDesktopScenarioName,
} from "./fake-desktop-bridge";

// Fixtures for throwaway probes in .dev/probes; see docs/agent-testing.md#browser-probes.

const repoRoot = path.resolve(__dirname, "../../../..");
const qaWebScript = path.join(repoRoot, "scripts/qa-web.mjs");
const CONSOLE_TAIL = 200;

export interface QaWeb {
  url: string;
  serverId: string;
  home: string;
  seed?: { agents: { title: string; id: string }[]; missing: unknown[] };
}

interface ProbeWorkerFixtures {
  qaSeed: boolean;
  qa: QaWeb;
}

interface ProbeTestFixtures {
  desktop: FakeDesktopScenarioName | undefined;
  consoleLines: string[];
}

function runQaWeb(args: string[]): string {
  return execFileSync(process.execPath, [qaWebScript, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

async function formatConsoleMessage(message: ConsoleMessage): Promise<string> {
  // Arguments as the page passed them, so React's "%s" warnings arrive substituted.
  const values = await Promise.all(
    message.args().map((arg) => arg.jsonValue().catch(() => arg.toString())),
  );
  const text = values.length > 0 ? format(...values) : message.text();
  return `[${message.type()}] ${text}`;
}

export const probe = base.extend<ProbeTestFixtures, ProbeWorkerFixtures>({
  qaSeed: [true, { scope: "worker", option: true }],
  qa: [
    async ({ qaSeed }, provide) => {
      // PROBE_URL points at a server someone else runs: no boot, and no stop.
      const external = process.env.PROBE_URL;
      if (external) {
        await provide({ url: external, serverId: process.env.PROBE_SERVER_ID ?? "", home: "" });
        return;
      }
      const qa = JSON.parse(runQaWeb(qaSeed ? ["--seed", "heavy"] : [])) as QaWeb;
      try {
        await provide(qa);
      } finally {
        runQaWeb(["--stop", qa.home]);
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ qa }, provide) => {
    await provide(qa.url);
  },
  desktop: [undefined, { option: true }],
  page: async ({ page, desktop, qa }, provide) => {
    if (desktop) {
      if (!qa.serverId) throw new Error("desktop scenarios need PROBE_SERVER_ID with PROBE_URL");
      await page.addInitScript(installFakeDesktopBridge, fakeDesktopScenario(desktop, qa));
    }
    await provide(page);
  },
  consoleLines: [
    async ({ page }, provide, testInfo) => {
      // Filled as messages arrive, in arrival order, so a probe can read it while it runs.
      const lines: string[] = [];
      let order = Promise.resolve();
      page.on("console", (message) => {
        const formatted = formatConsoleMessage(message);
        const previous = order;
        order = (async () => {
          await previous;
          lines.push(await formatted);
        })();
      });
      await provide(lines);
      await order;
      if (testInfo.status !== testInfo.expectedStatus) {
        // Written beside the screenshot, so it survives without the HTML report.
        const tail = testInfo.outputPath("console-tail.txt");
        await writeFile(tail, `${lines.slice(-CONSOLE_TAIL).join("\n")}\n`);
        await testInfo.attach("console-tail.txt", { path: tail, contentType: "text/plain" });
      }
    },
    { auto: true },
  ],
});

export { expect };
