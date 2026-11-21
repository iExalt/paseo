import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AgentOptions,
  LocalAgentStore,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage,
  SDKModel,
  SDKUserMessage,
  TokenUsage,
} from "@cursor/sdk";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";
import { resolvePaseoHome } from "../../paseo-home.js";
import type {
  AgentClient,
  AgentDraftControls,
  AgentLaunchContext,
  AgentMode,
  AgentOptionSelectControl,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { runProviderRefreshActivity } from "../provider-refresh-deadline.js";
import { composeSystemPromptParts } from "../system-prompt.js";

const PROVIDER = "cursor-sdk";
const MODE = "unrestricted";
const MODES = getAgentProviderDefinition(PROVIDER).modes;
const DEFAULT_MODEL = "auto";
const PARAMETER_PREFIX = "cursor_model_";
const RUN_INSTRUCTIONS_START = "<paseo_instructions>\n";
const RUN_INSTRUCTIONS_END = "\n</paseo_instructions>\n\n";
const MISSING_CREDENTIAL =
  "Cursor SDK requires CURSOR_API_KEY. Set it in the daemon environment or in agents.providers.cursor-sdk.env, then reload the daemon configuration.";
const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsPaseoCli: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

type CursorSdk = Pick<typeof import("@cursor/sdk"), "Agent" | "JsonlLocalAgentStore">;

// The public SDK messages API returns the checkpoint turn as an opaque value.
const checkpointPromptSchema = z.object({
  turn: z.object({
    case: z.literal("agentConversationTurn"),
    value: z.object({
      userMessage: z.object({ text: z.string(), messageId: z.string(), startedAtMs: z.bigint() }),
    }),
  }),
});

function modelId(id?: string | null): string {
  return id?.trim() || DEFAULT_MODEL;
}

function parameterControls(model: SDKModel | undefined): AgentOptionSelectControl[] {
  const defaults = model?.variants?.find((variant) => variant.isDefault)?.params;
  return (model?.parameters ?? []).map((parameter) => ({
    type: "select",
    key: PARAMETER_PREFIX + parameter.id,
    label: parameter.displayName ?? parameter.id,
    defaultValue: defaults?.find((value) => value.id === parameter.id)?.value,
    choices: parameter.values.map((choice) => ({
      value: choice.value,
      label: choice.displayName ?? choice.value,
    })),
  }));
}

function selectModel(
  id: string,
  options: ProviderOptions,
  controls: AgentOptionSelectControl[],
): ModelSelection {
  const params = controls.flatMap((control) => {
    const value = options[control.key] ?? control.defaultValue;
    if (value == null || !control.choices.some((choice) => choice.value === value)) {
      return [];
    }
    return [{ id: control.key.slice(PARAMETER_PREFIX.length), value: String(value) }];
  });
  return params.length ? { id, params } : { id };
}

function assertMode(mode?: string): void {
  if (mode && mode !== MODE) {
    throw new Error("Cursor SDK supports only Unrestricted mode.");
  }
}

function mapUsage(usage: TokenUsage | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
  };
}

function makePrompt(input: AgentPromptInput): SDKUserMessage {
  const images: SDKUserMessage["images"] = [];
  const text =
    typeof input === "string"
      ? input
      : input
          .flatMap((block) => {
            if (block.type === "image") {
              images.push({ data: block.data, mimeType: block.mimeType });
              return [];
            }
            return [block.type === "text" ? block.text : renderPromptAttachmentAsText(block)];
          })
          .join("\n\n");
  return images.length ? { text, images } : { text };
}

function historyPrompt(text: string): string {
  const end = text.startsWith(RUN_INSTRUCTIONS_START) ? text.indexOf(RUN_INSTRUCTIONS_END) : -1;
  return end < 0 ? text : text.slice(end + RUN_INSTRUCTIONS_END.length);
}

// Cursor.models.list has no AbortSignal. A worker lets us close the request before
// releasing the refresh deadline, including on a stalled SDK connection.
export async function listCursorModels(
  apiKey: string,
  signal: AbortSignal,
  sdkUrl = import.meta.resolve("@cursor/sdk"),
): Promise<SDKModel[]> {
  signal.throwIfAborted();
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { Cursor } = await import(workerData.sdkUrl);
      parentPort.postMessage(await Cursor.models.list({ apiKey: workerData.apiKey }));
    })();`,
    { eval: true, execArgv: [], workerData: { apiKey, sdkUrl } },
  );
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<SDKModel[]>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(new Error("Cursor SDK catalog worker exited with code " + code)),
      );
    });
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    await worker.terminate();
  }
}

function assertNoInheritedAgentIdentity(): void {
  if (process.env.PASEO_AGENT_ID?.trim()) {
    throw new Error("Start the daemon outside a Paseo agent shell before using Cursor SDK.");
  }
}

export class CursorSdkAgentClient implements AgentClient {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  private readonly apiKey: string | undefined;
  private store: LocalAgentStore | undefined;
  private catalog: SDKModel[] | undefined;
  private readonly storePath = join(resolvePaseoHome(), "cursor-sdk");

  constructor(
    runtimeSettings?: ProviderRuntimeSettings,
    private readonly loadSdk: () => Promise<CursorSdk> = () => import("@cursor/sdk"),
    private readonly listModels = listCursorModels,
  ) {
    this.apiKey = (runtimeSettings?.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY)?.trim();
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error(MISSING_CREDENTIAL);
    }
    return this.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    this.requireApiKey();
    return true;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return {
      diagnostic: this.apiKey ? "CURSOR_API_KEY is configured for Cursor SDK." : MISSING_CREDENTIAL,
    };
  }

  private async fetchModels(signal?: AbortSignal): Promise<SDKModel[]> {
    const timeout = AbortSignal.timeout(30_000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const models = await this.listModels(this.requireApiKey(), bounded);
    bounded.throwIfAborted();
    this.catalog = models;
    return models;
  }

  async fetchCatalog(
    _options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    context?.signal.throwIfAborted();
    const models = await runProviderRefreshActivity(context, "cursor-sdk-models", () =>
      this.fetchModels(context?.signal),
    );
    context?.signal.throwIfAborted();
    return {
      models: models.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        aliases: model.aliases,
        label: model.displayName,
        description: model.description,
        isDefault: model.id === DEFAULT_MODEL,
        metadata: { parameters: model.parameters, variants: model.variants },
      })),
      modes: MODES,
      defaultModeId: MODE,
    };
  }

  private async getControls(id: string): Promise<AgentOptionSelectControl[]> {
    const models = this.catalog ?? (await this.fetchModels());
    return parameterControls(
      models.find((model) => model.id === id || model.aliases?.includes(id)),
    );
  }

  async listControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    return {
      controls: await this.getControls(modelId(config.model)),
      options: config.providerOptions ?? {},
    };
  }

  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return this.openSession(config, launchContext);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const id = handle.nativeHandle ?? handle.sessionId;
    const savedCwd = handle.metadata?.cwd;
    if (!id.startsWith("agent-") || typeof savedCwd !== "string") {
      throw new Error("Cursor SDK can only resume a saved local agent and workspace.");
    }
    const cwd = await realpath(savedCwd);
    if (overrides?.cwd && (await realpath(overrides.cwd)) !== cwd) {
      throw new Error("Cursor SDK must resume its original workspace.");
    }
    return this.openSession(
      { ...overrides, provider: PROVIDER, cwd },
      launchContext,
      id,
      options?.purpose === "history",
    );
  }

  private async openSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    nativeId?: string,
    historyOnly = false,
  ): Promise<AgentSession> {
    assertNoInheritedAgentIdentity();
    const apiKey = this.requireApiKey();
    assertMode(config.modeId);
    const cwd = await realpath(config.cwd);
    const sdk = await this.loadSdk();
    const store = (this.store ??= new sdk.JsonlLocalAgentStore(this.storePath));
    const id = modelId(config.model);
    const providerOptions = config.providerOptions ?? {};
    const controls = await this.getControls(id);
    const options: AgentOptions = {
      apiKey,
      model: selectModel(id, providerOptions, controls),
      name: config.title ?? undefined,
      local: {
        cwd,
        store,
        settingSources: [],
        sandboxOptions: { enabled: false },
        autoReview: false,
      },
      mcpServers: { ...config.mcpServers, ...launchContext?.mcpServers },
    };

    if (nativeId && !historyOnly) {
      await clearUnusedCursorReservation(sdk.Agent, store, nativeId, cwd);
    }
    const agent = nativeId
      ? await sdk.Agent.resume(nativeId, options)
      : await sdk.Agent.create(options);
    return new CursorSdkAgent(
      agent,
      cwd,
      id,
      providerOptions,
      controls,
      (model) => this.getControls(model),
      composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt),
      sdk.Agent,
      store,
    );
  }
}

// SDK create reserves a queued first run. A new handle opened by resume cannot
// reuse that reservation, but must never clear work that already started.
export async function clearUnusedCursorReservation(
  sdkAgent: Pick<CursorSdk["Agent"], "cancelRun">,
  store: LocalAgentStore,
  agentId: string,
  cwd: string,
): Promise<void> {
  const agent = await store.agents.get({ agentId });
  if (!agent?.activeRunId || agent.cwd !== cwd || agent.latestCheckpoint) {
    return;
  }
  const run = await store.runs.get({ agentId, runId: agent.activeRunId });
  if (run?.status === "queued" && run.turnNumber === 1 && run.startedAt == null) {
    await sdkAgent.cancelRun(run.runId, { runtime: "local", cwd, store });
  }
}

function mapTool(
  message: Extract<SDKMessage, { type: "tool_call" }>,
  previous?: ToolCallTimelineItem,
): ToolCallTimelineItem {
  const prior = previous?.detail.type === "unknown" ? previous.detail : undefined;
  const base = {
    type: "tool_call" as const,
    callId: `${message.run_id}:${message.call_id}`,
    name: message.name,
    detail: {
      type: "unknown" as const,
      input: message.args ?? prior?.input ?? null,
      output: message.result ?? prior?.output ?? null,
    },
  };
  if (message.status === "error") {
    return { ...base, status: "failed", error: message.result ?? "Cursor tool failed." };
  }
  return { ...base, status: message.status, error: null };
}

function streamItems(
  message: SDKMessage,
  tools: Map<string, ToolCallTimelineItem>,
  history: boolean,
): AgentTimelineItem[] {
  switch (message.type) {
    case "assistant":
      return message.message.content.flatMap((block) =>
        block.type === "text" && block.text
          ? [{ type: "assistant_message" as const, text: block.text }]
          : [],
      );
    case "thinking":
      return message.text ? [{ type: "reasoning", text: message.text }] : [];
    case "tool_call": {
      const key = `${message.run_id}:${message.call_id}`;
      const item = mapTool(message, tools.get(key));
      tools.set(key, item);
      return [item];
    }
    case "user": {
      if (!history) {
        return []; // The adapter already emitted the submitted prompt for this run.
      }
      const text = historyPrompt(message.message.content.map((block) => block.text).join(""));
      return text ? [{ type: "user_message", text }] : [];
    }
    default:
      return [];
  }
}

function terminalTools(
  tools: Map<string, ToolCallTimelineItem>,
  status: RunResult["status"],
): ToolCallTimelineItem[] {
  return Array.from(tools.values()).flatMap((item): ToolCallTimelineItem[] => {
    if (item.status !== "running") {
      return [];
    }
    return [
      status === "cancelled"
        ? { ...item, status: "canceled" }
        : { ...item, status: "failed", error: "Cursor did not return a tool result." },
    ];
  });
}

function writeHistoryItem(
  items: AgentTimelineItem[],
  positions: Map<string, number>,
  item: AgentTimelineItem,
): void {
  if (item.type === "tool_call") {
    const position = positions.get(item.callId) ?? items.length;
    positions.set(item.callId, position);
    items[position] = item;
    return;
  }
  const previous = items.at(-1);
  if (
    (item.type === "assistant_message" || item.type === "reasoning") &&
    previous?.type === item.type
  ) {
    previous.text += item.text;
    return;
  }
  items.push(item);
}

interface Turn {
  id: string;
  native: Promise<Run>;
  completion: Promise<AgentRunResult>;
  stop?: Promise<void>;
  stopping: boolean;
}

class CursorSdkAgent implements AgentSession {
  readonly provider = PROVIDER;
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private active: Turn | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    private readonly agent: SDKAgent,
    private readonly cwd: string,
    private model: string,
    private options: ProviderOptions,
    private modelControls: AgentOptionSelectControl[],
    private readonly getControls: (model: string) => Promise<AgentOptionSelectControl[]>,
    private readonly instructions: string | undefined,
    private readonly sdkAgent: CursorSdk["Agent"],
    private readonly store: LocalAgentStore,
  ) {
    this.id = agent.agentId;
  }

  get controls(): AgentOptionSelectControl[] {
    return this.modelControls;
  }

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private begin(prompt: AgentPromptInput, options?: AgentRunOptions): Turn {
    if (this.closed || this.closing) {
      throw new Error("Cursor SDK session is closing or closed.");
    }
    if (this.active) {
      throw new Error("Cursor SDK is still running or stopping its current turn.");
    }
    assertNoInheritedAgentIdentity();
    const id = randomUUID();
    const input = makePrompt(prompt);
    const text = this.instructions
      ? RUN_INSTRUCTIONS_START + this.instructions + RUN_INSTRUCTIONS_END + input.text
      : input.text;
    const native = Promise.resolve().then(() =>
      this.agent.send(
        { ...input, text },
        {
          model: selectModel(this.model, this.options, this.modelControls),
        },
      ),
    );
    const completion = this.consume(id, native, input.text, options?.clientMessageId);
    const turn: Turn = { id, native, completion, stopping: false };
    this.active = turn;
    void turn.completion.catch(() => {});
    return turn;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.begin(prompt, options).completion;
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return { turnId: this.begin(prompt, options).id };
  }

  private async consume(
    turnId: string,
    native: Promise<Run>,
    text: string,
    clientMessageId?: string,
  ): Promise<AgentRunResult> {
    const provider = PROVIDER;
    const timeline: AgentTimelineItem[] = [];
    const tools = new Map<string, ToolCallTimelineItem>();
    let streamedText = "";
    let errorCode: string | undefined;
    const emitItem = (item: AgentTimelineItem) => {
      timeline.push(item);
      if (item.type === "assistant_message") {
        streamedText += item.text;
      }
      this.emit({ type: "timeline", item, provider, turnId });
    };
    try {
      await Promise.resolve();
      this.emit({ type: "turn_started", provider, turnId });
      const run = await native;
      emitItem({ type: "user_message", text, ...(clientMessageId ? { clientMessageId } : {}) });
      let streamError: unknown;
      try {
        for await (const message of run.stream()) {
          for (const item of streamItems(message, tools, false)) {
            emitItem(item);
          }
        }
      } catch (error) {
        streamError = error;
      }
      const result = await run.wait();
      const usage = mapUsage(result.usage);
      for (const item of terminalTools(tools, result.status)) {
        emitItem(item);
      }
      if (result.status === "error") {
        errorCode = result.error?.code;
        throw new Error(result.error?.message ?? "Cursor SDK run failed.");
      }
      if (result.status === "cancelled") {
        this.emit({ type: "turn_canceled", provider, turnId, reason: "Cursor SDK run canceled." });
        return { sessionId: this.id, finalText: streamedText, timeline, usage, canceled: true };
      }
      if (streamError) {
        throw streamError;
      }
      if (!streamedText && result.result) {
        emitItem({ type: "assistant_message", text: result.result });
      }
      this.emit({ type: "turn_completed", provider, turnId, usage });
      return { sessionId: this.id, finalText: result.result ?? streamedText, timeline, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "turn_failed", provider, turnId, error: message, code: errorCode });
      throw error;
    } finally {
      if (this.active?.id === turnId && !this.active.stopping) {
        this.active = undefined;
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const local = { runtime: "local" as const, cwd: this.cwd, store: this.store };
    let cursor: string | undefined;
    const runs = new Map<string, Run>();
    do {
      const page = await this.sdkAgent.listRuns(this.id, { ...local, cursor });
      for (const run of page.items) {
        if (run.status !== "running") {
          runs.set(run.id, run);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    const ordered = [...runs.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const prompts = await this.checkpointPromptsByRun(ordered);
    for (const run of ordered) {
      const turnId = run.id;
      const timestamp =
        run.createdAt === undefined ? undefined : new Date(run.createdAt).toISOString();
      const tools = new Map<string, ToolCallTimelineItem>();
      const items: AgentTimelineItem[] = [];
      const positions = new Map<string, number>();
      for await (const message of run.stream()) {
        for (const item of streamItems(message, tools, true)) {
          writeHistoryItem(items, positions, item);
        }
      }
      const prompt = prompts.get(run.id);
      if (prompt && !items.some((item) => item.type === "user_message")) {
        items.unshift(prompt);
      }
      const result = await run.wait();
      for (const item of terminalTools(tools, result.status)) {
        writeHistoryItem(items, positions, item);
      }
      if (!items.some((item) => item.type === "assistant_message") && result.result) {
        items.push({ type: "assistant_message", text: result.result });
      }
      if (result.status === "error") {
        items.push({ type: "error", message: result.error?.message ?? "Cursor SDK run failed." });
      }
      for (const item of items) {
        yield { type: "timeline", item, provider: PROVIDER, turnId, timestamp };
      }
    }
  }

  private async checkpointPromptsByRun(runs: Run[]) {
    const byRun = new Map<string, Extract<AgentTimelineItem, { type: "user_message" }>>();
    if (runs.length === 0) return byRun;
    const messages = await this.sdkAgent.messages.list(this.id, {
      runtime: "local",
      cwd: this.cwd,
      store: this.store,
    });
    const prompts = messages
      .flatMap(({ message }) => {
        const parsed = checkpointPromptSchema.safeParse(message);
        if (!parsed.success) return [];
        const { text, messageId, startedAtMs } = parsed.data.turn.value.userMessage;
        const time = Number(startedAtMs);
        return Number.isSafeInteger(time) && time > 0
          ? [{ text: historyPrompt(text), messageId, time }]
          : [];
      })
      .sort((a, b) => a.time - b.time);
    // The SDK checkpoint contains prompts but no run IDs. Only use a single
    // prompt inside the run's time window, and consume each checkpoint once.
    let nextPrompt = 0;
    for (const run of runs) {
      if (nextPrompt >= prompts.length) break;
      const stored = await this.store.runs.get({ agentId: this.id, runId: run.id });
      if (stored?.endedAt == null) continue;
      const start = stored.startedAt ?? stored.createdAt;
      while (nextPrompt < prompts.length && prompts[nextPrompt].time < start) nextPrompt++;
      const first = nextPrompt;
      while (nextPrompt < prompts.length && prompts[nextPrompt].time <= stored.endedAt) {
        nextPrompt++;
      }
      if (nextPrompt === first + 1) {
        const { text, messageId } = prompts[first];
        byRun.set(run.id, { type: "user_message", text, messageId });
      }
    }
    return byRun;
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: PROVIDER, sessionId: this.id, model: this.model, modeId: MODE };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MODES;
  }

  async getCurrentMode(): Promise<string> {
    return MODE;
  }

  async setMode(mode: string): Promise<void> {
    assertMode(mode);
  }

  async setModel(model: string | null): Promise<{ model: string }> {
    const id = modelId(model);
    this.modelControls = await this.getControls(id);
    this.model = id;
    return { model: id };
  }

  async applyOptions(patch: ProviderOptions): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      const control = this.modelControls.find((entry) => entry.key === key);
      if (
        !control ||
        (value !== null && !control.choices.some((choice) => choice.value === value))
      ) {
        throw new Error("Unsupported Cursor SDK model option " + key);
      }
    }
    this.options = { ...this.options, ...patch };
  }

  getPendingPermissions(): [] {
    return [];
  }

  async respondToPermission(): Promise<void> {
    throw new Error("Cursor SDK does not provide interactive approvals.");
  }

  describePersistence(): AgentPersistenceHandle {
    return {
      provider: PROVIDER,
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { cwd: this.cwd },
    };
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) {
      return;
    }
    turn.stopping = true;
    turn.stop ??= this.stop(turn);
    try {
      await turn.stop;
    } catch (error) {
      turn.stop = undefined;
      throw error;
    }
  }

  private async stop(turn: Turn): Promise<void> {
    const run = await turn.native.catch(() => undefined);
    if (run) {
      if (run.status === "running" && !run.supports("cancel")) {
        throw new Error("Cursor SDK cannot confirm cancellation for this run.");
      }
      await run.cancel();
      // A wait started after cancel joins the SDK's local execution controller.
      await run.wait();
    }
    await turn.completion.catch(() => {});
    if (this.active === turn) {
      this.active = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closing ??= this.dispose();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  private async dispose(): Promise<void> {
    await this.interrupt();
    this.closed = true;
    try {
      await this.agent[Symbol.asyncDispose]();
    } finally {
      this.listeners.clear();
    }
  }
}
