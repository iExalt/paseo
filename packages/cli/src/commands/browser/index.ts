import { access, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import {
  BrowserAutomationCommandSchema,
  BrowserAutomationResultSchema,
  type BrowserAutomationCommand,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { normalizeBrowserHttpUrlInput } from "@getpaseo/protocol/browser-automation/url";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import { connectToDaemon } from "../../utils/client.js";
import {
  withOutput,
  type CommandError,
  type OutputSchema,
  type SingleResult,
  type CommandOptions,
} from "../../output/index.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

type BrowserOperation = BrowserAutomationCommand["command"];
type BrowserOutput = Record<string, unknown>;

const BrowserCommandOptionsSchema = z.record(z.string(), z.unknown());
const DaemonTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance"), home: z.string() }).strict(),
  z.object({ kind: z.literal("endpoint"), host: z.string() }).strict(),
]);
const BrowserOutputSchema: OutputSchema<BrowserOutput> = {
  idField: (result) => String(result.command ?? "browser"),
  columns: [
    { header: "COMMAND", field: (result) => result.command ?? "-" },
    { header: "TAB", field: (result) => result.browserId ?? result.workspaceId ?? "-" },
    { header: "RESULT", field: (result) => summarizeBrowserOutput(result) },
  ],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};

const BrowserResultSchema = z.record(z.string(), z.unknown());

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Control connected Paseo browser tabs");

  addBrowserAction(browser, "list-tabs", "List open browser tabs", "list_tabs", []);
  addBrowserAction(browser, "new-tab", "Open a background browser tab", "new_tab", [
    { name: "[url]", description: "Optional HTTP(S) URL (scheme-less hosts use HTTP)" },
  ]);
  addBrowserAction(
    browser,
    "snapshot",
    "Read the current page and element references",
    "snapshot",
    [{ name: "<browser-id>", description: "Tab ID from list-tabs or new-tab" }],
  );
  addBrowserAction(browser, "click", "Click a page element", "click", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<ref>", description: "Element ref from the latest snapshot" },
  ])
    .option("--button <button>", "Mouse button (left, right, middle)", "left")
    .option("--double-click", "Click twice")
    .option("--modifier <modifier>", "Input modifier (repeatable)", collectMultiple, []);
  addBrowserAction(browser, "fill", "Replace an input value", "fill", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<ref>", description: "Element ref from the latest snapshot" },
    { name: "<value>", description: "Value to fill" },
  ]);
  addBrowserAction(browser, "wait", "Wait for page text or URL", "wait", [
    { name: "<browser-id>", description: "Tab ID" },
  ])
    .option("--text <text>", "Wait for visible text")
    .option("--url <url>", "Wait for a URL match")
    .option("--timeout-ms <ms>", "Wait timeout (1-30000 ms)");
  addBrowserAction(browser, "type", "Type into a page element or focused control", "type", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<text>", description: "Text to type" },
  ]).option("--ref <ref>", "Element ref from the latest snapshot");
  addBrowserAction(browser, "keypress", "Send a key to the page", "keypress", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<key>", description: "Key name" },
  ]).option("--ref <ref>", "Element ref from the latest snapshot");
  addBrowserAction(browser, "navigate", "Navigate a tab to an HTTP(S) URL", "navigate", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<url>", description: "URL to open" },
  ]);
  addBrowserAction(browser, "back", "Go back in tab history", "back", [
    { name: "<browser-id>", description: "Tab ID" },
  ]);
  addBrowserAction(browser, "forward", "Go forward in tab history", "forward", [
    { name: "<browser-id>", description: "Tab ID" },
  ]);
  addBrowserAction(browser, "reload", "Reload a browser tab", "reload", [
    { name: "<browser-id>", description: "Tab ID" },
  ]);
  addBrowserAction(browser, "screenshot", "Save a tab screenshot as a PNG", "screenshot", [
    { name: "<browser-id>", description: "Tab ID" },
  ])
    .requiredOption("--output <path>", "Local path for the PNG artifact")
    .option("--full-page", "Capture the full page");
  addBrowserAction(browser, "upload", "Upload files through a page file input", "upload", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<ref>", description: "File input ref from the latest snapshot" },
  ]).requiredOption("--file <path>", "File path to upload (repeatable)", collectMultiple, []);
  addBrowserAction(browser, "select", "Select an option in a page control", "select", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<ref>", description: "Select control ref from the latest snapshot" },
    { name: "<value>", description: "Option value" },
  ]);
  addBrowserAction(browser, "hover", "Hover over a page element", "hover", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<ref>", description: "Element ref from the latest snapshot" },
  ]);
  addBrowserAction(browser, "drag", "Drag one element onto another", "drag", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<source-ref>", description: "Source element ref" },
    { name: "<target-ref>", description: "Target element ref" },
  ]);
  addBrowserAction(browser, "logs", "Read console and network logs", "logs", [
    { name: "<browser-id>", description: "Tab ID" },
  ]).option("--max-entries <n>", "Maximum entries (1-200; default 50)");
  addBrowserAction(browser, "evaluate", "Evaluate a JavaScript function in a tab", "evaluate", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<function>", description: "JavaScript function source" },
  ]).option("--ref <ref>", "Pass the referenced element to the function");
  addBrowserAction(browser, "scroll", "Scroll the page in CSS pixels", "scroll", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<delta-x>", description: "Horizontal CSS pixel delta" },
    { name: "<delta-y>", description: "Vertical CSS pixel delta" },
  ]).option("--ref <ref>", "Scroll relative to an element");
  addBrowserAction(browser, "resize", "Resize a tab viewport", "resize", [
    { name: "<browser-id>", description: "Tab ID" },
    { name: "<width>", description: "Viewport width in pixels" },
    { name: "<height>", description: "Viewport height in pixels" },
  ]);
  addBrowserAction(browser, "close-tab", "Close a browser tab", "close_tab", [
    { name: "<browser-id>", description: "Tab ID" },
  ]);

  return browser;
}

function addBrowserAction(
  browser: Command,
  name: string,
  description: string,
  operation: BrowserOperation,
  args: Array<{ name: string; description: string }>,
): Command {
  let command = browser.command(name).description(description);
  for (const argument of args) command = command.argument(argument.name, argument.description);
  command
    .option("--agent <id>", "Agent whose runtime directory scopes tab creation and listing")
    .option("--workspace <id>", "Workspace that scopes tab creation and listing");
  addJsonAndDaemonHostOptions(command);
  command.action(withOutput(createBrowserAction(operation)));
  return command;
}

function createBrowserAction(
  operation: BrowserOperation,
): (...args: [...string[], CommandOptions, Command]) => Promise<SingleResult<BrowserOutput>> {
  return async (...actionArgs: [...string[], CommandOptions, Command]) => {
    const command = actionArgs[actionArgs.length - 1];
    if (!(command instanceof Command)) throw new Error("Browser command context is unavailable");
    const options = BrowserCommandOptionsSchema.parse(actionArgs[actionArgs.length - 2]);
    const positionalArgs = z
      .array(z.string().optional())
      .parse(actionArgs.slice(0, -2))
      .filter((argument): argument is string => argument !== undefined);
    const parsedCommand = buildBrowserCommand(operation, positionalArgs, options);
    const requestedAgentId = getOptionString(options, "agent");
    const workspaceId = getOptionString(options, "workspace");
    if (requestedAgentId !== undefined && !requestedAgentId.trim()) {
      throw invalidBrowserCommand("--agent cannot be empty.");
    }
    if (workspaceId !== undefined && !workspaceId.trim()) {
      throw invalidBrowserCommand("--workspace cannot be empty.");
    }

    const outputPath =
      operation === "screenshot" ? await validateScreenshotOutput(options) : undefined;
    const client = await connectToDaemon({ target: getDaemonTarget(options) });
    const abortController = new AbortController();
    const abort = () => abortController.abort(new Error("Browser command interrupted."));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      // COMPAT(browserCommandCli): added in v0.11.2; remove gate after 2027-04-10 once daemon floor >= v0.11.2.
      if (client.getLastServerInfoMessage()?.features?.browserCommandCli !== true) {
        throw {
          code: "UNSUPPORTED_FEATURE",
          message: "The connected daemon does not support browser commands.",
          details: "Update the daemon before using browser commands.",
        } satisfies CommandError;
      }
      const agentId = requestedAgentId?.trim() || (await resolveCallerAgentId(client));
      const response = await client.executeBrowserCommand(
        {
          command: parsedCommand,
          ...(agentId ? { agentId } : {}),
          ...(workspaceId ? { workspaceId: workspaceId.trim() } : {}),
        },
        { signal: abortController.signal },
      );
      if (!response.result.ok) {
        throw {
          code: response.result.error.code,
          message: response.result.error.message,
          details: response.result.error.retryable ? "The operation may be retried." : undefined,
        } satisfies CommandError;
      }

      const result = await prepareBrowserResult(response.result.result, outputPath);
      const data = BrowserResultSchema.parse({
        ok: true,
        result,
        ...(response.result.dialogs ? { dialogs: response.result.dialogs } : {}),
        context: response.context,
      });
      return { type: "single", data, schema: BrowserOutputSchema };
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      await client.close().catch(() => undefined);
    }
  };
}

// Each command has an explicit positional and option mapping to the shared protocol schema.
// eslint-disable-next-line complexity
function buildBrowserCommand(
  operation: BrowserOperation,
  positionals: string[],
  options: Record<string, unknown>,
): BrowserAutomationCommand {
  const positional = (index: number, label: string): string => {
    const value = positionals[index];
    if (value === undefined) throw invalidBrowserCommand(`${label} is required.`);
    return value;
  };
  const args: Record<string, unknown> = {};
  switch (operation) {
    case "list_tabs":
      break;
    case "new_tab": {
      const url = positionals[0];
      if (url !== undefined) args.url = normalizedUrl(url);
      break;
    }
    case "snapshot":
    case "back":
    case "forward":
    case "reload":
    case "close_tab":
      args.browserId = positional(0, "<browser-id>");
      break;
    case "click":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        ref: positional(1, "<ref>"),
        button: getOptionString(options, "button") ?? "left",
        doubleClick: getOptionBoolean(options, "doubleClick"),
        modifiers: getOptionStringArray(options, "modifier"),
      });
      break;
    case "fill":
    case "select":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        ref: positional(1, "<ref>"),
        value: positional(2, "<value>"),
      });
      break;
    case "wait":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        text: getOptionString(options, "text"),
        url: getOptionString(options, "url"),
        timeoutMs: getOptionNumber(options, "timeoutMs"),
      });
      break;
    case "type":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        text: positional(1, "<text>"),
        ref: getOptionString(options, "ref"),
      });
      break;
    case "keypress":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        key: positional(1, "<key>"),
        ref: getOptionString(options, "ref"),
      });
      break;
    case "navigate":
      args.browserId = positional(0, "<browser-id>");
      args.url = normalizedUrl(positional(1, "<url>"));
      break;
    case "screenshot":
      args.browserId = positional(0, "<browser-id>");
      args.fullPage = getOptionBoolean(options, "fullPage");
      break;
    case "upload":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        ref: positional(1, "<ref>"),
        filePaths: getOptionStringArray(options, "file"),
      });
      break;
    case "hover":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        ref: positional(1, "<ref>"),
      });
      break;
    case "drag":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        sourceRef: positional(1, "<source-ref>"),
        targetRef: positional(2, "<target-ref>"),
      });
      break;
    case "logs":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        maxEntries: getOptionNumber(options, "maxEntries"),
      });
      break;
    case "evaluate":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        function: positional(1, "<function>"),
        ref: getOptionString(options, "ref"),
      });
      break;
    case "scroll":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        deltaX: Number(positional(1, "<delta-x>")),
        deltaY: Number(positional(2, "<delta-y>")),
        ref: getOptionString(options, "ref"),
      });
      break;
    case "resize":
      Object.assign(args, {
        browserId: positional(0, "<browser-id>"),
        width: Number(positional(1, "<width>")),
        height: Number(positional(2, "<height>")),
      });
      break;
  }
  try {
    return BrowserAutomationCommandSchema.parse({ command: operation, args });
  } catch (error) {
    throw invalidBrowserCommand(error instanceof Error ? error.message : String(error));
  }
}

function normalizedUrl(value: string): string {
  const normalized = normalizeBrowserHttpUrlInput(value);
  if (!normalized) throw invalidBrowserCommand("URL must use http/https only.");
  return normalized;
}

async function validateScreenshotOutput(options: Record<string, unknown>): Promise<string> {
  const requested = getOptionString(options, "output")?.trim();
  if (!requested) throw invalidBrowserCommand("Screenshot commands require --output <path>.");
  const outputPath = resolve(requested);
  const parentStats = await stat(dirname(outputPath)).catch(() => null);
  if (!parentStats?.isDirectory()) {
    throw invalidBrowserCommand("The screenshot output directory must already exist.");
  }
  const targetStats = await stat(outputPath).catch(() => null);
  if (targetStats?.isDirectory())
    throw invalidBrowserCommand("The screenshot output path is a directory.");
  await access(dirname(outputPath));
  return outputPath;
}

async function prepareBrowserResult(
  input: unknown,
  outputPath: string | undefined,
): Promise<BrowserOutput> {
  const result = BrowserAutomationResultSchema.parse(input);
  if (result.command !== "screenshot") return result;
  if (!outputPath || typeof result.dataBase64 !== "string") {
    throw invalidBrowserCommand("The browser screenshot response did not contain image data.");
  }
  const { dataBase64, ...metadata } = result;
  await writeFile(outputPath, Buffer.from(dataBase64, "base64"));
  return BrowserResultSchema.parse({ ...metadata, outputPath });
}

function summarizeBrowserOutput(result: BrowserOutput): string {
  if (Array.isArray(result.tabs)) return `${result.tabs.length} open tabs`;
  return String(result.url ?? result.ref ?? result.command ?? "completed");
}

function getOptionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function getOptionStringArray(options: Record<string, unknown>, key: string): string[] {
  const value = options[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidBrowserCommand(`--${key} must be supplied as a string value.`);
  }
  return value;
}

function getOptionNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = getOptionString(options, key);
  return value === undefined ? undefined : Number(value);
}

function getOptionBoolean(options: Record<string, unknown>, key: string): boolean {
  return options[key] === true;
}

function getDaemonTarget(options: Record<string, unknown>): DaemonTarget {
  return DaemonTargetSchema.parse(options.daemonTarget);
}

function invalidBrowserCommand(message: string): CommandError {
  return { code: "INVALID_BROWSER_COMMAND", message };
}
