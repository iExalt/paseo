import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentOptions,
  LocalAgentStore,
  ModelSelection,
  Run,
  SDKAgent,
  SDKModel,
  SDKUserMessage,
  TokenUsage,
} from "@cursor/sdk";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
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
  AgentSlashCommand,
  AgentStreamEvent,
  AgentUsage,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { runProviderRefreshActivity } from "../provider-refresh-deadline.js";
import { composeSystemPromptParts } from "../system-prompt.js";

import {
  CURSOR_SDK_PROVIDER as PROVIDER,
  getCursorSdkEnvKey,
  readCursorSdkStoredKey,
} from "./cursor-sdk-auth.js";
import {
  CursorSdkAvailabilityError,
  listCursorSdkModels,
  verifyCursorSdkHelper,
} from "./cursor-sdk-availability.js";
import {
  type HistorySdk,
  openCursorHistorySession,
  readCursorHistory,
  interruptedCursorRunMessage,
} from "./cursor-sdk-history.js";
import { assertCursorRunReleased } from "./cursor-sdk-recovery.js";
import { createCursorRunBinding } from "./cursor-sdk-run-binding.js";
import { CursorRunController } from "./cursor-sdk-run-controller.js";
import { CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

const MODE = "unrestricted";
const MODES = getAgentProviderDefinition(PROVIDER).modes;
const DEFAULT_MODEL = "auto";
const PARAMETER_PREFIX = "cursor_model_";
const RUN_INSTRUCTIONS_START = "<paseo_instructions>\n";
const RUN_INSTRUCTIONS_END = "\n</paseo_instructions>\n\n";
const MISSING_CREDENTIAL =
  "Sign in to Cursor SDK in host settings or configure CURSOR_API_KEY on the host.";
const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsOfflineHistory: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsPaseoCli: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

type CursorSdk = HistorySdk & Pick<typeof import("@cursor/sdk"), "Agent" | "JsonlLocalAgentStore">;

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

function assertNoInheritedAgentIdentity(): void {
  if (process.env.PASEO_AGENT_ID?.trim()) {
    throw new Error("Start the daemon outside a Paseo agent shell before using Cursor SDK.");
  }
}

export class CursorSdkAgentClient implements AgentClient {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  private binding?: ReturnType<typeof createCursorRunBinding>;
  private catalog: SDKModel[] | undefined;

  constructor(
    private readonly runtimeSettings?: ProviderRuntimeSettings,
    private readonly loadSdk: () => Promise<CursorSdk> = () => import("@cursor/sdk"),
    private readonly listModels = listCursorSdkModels,
    private readonly readStoredKey = readCursorSdkStoredKey,
    private readonly storePath = join(resolvePaseoHome(), "cursor-sdk"),
  ) {}

  private getBinding(sdk: CursorSdk): ReturnType<typeof createCursorRunBinding> {
    return (this.binding ??= createCursorRunBinding(new sdk.JsonlLocalAgentStore(this.storePath)));
  }

  private async requireApiKey(): Promise<string> {
    const key = getCursorSdkEnvKey(this.runtimeSettings) ?? (await this.readStoredKey());
    if (!key) throw new CursorSdkAvailabilityError("missing_credentials");
    return key;
  }

  async isAvailable(): Promise<boolean> {
    await verifyCursorSdkHelper();
    await this.requireApiKey();
    return true;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    if (getCursorSdkEnvKey(this.runtimeSettings)) {
      return { diagnostic: "CURSOR_API_KEY is configured for Cursor SDK." };
    }
    return {
      diagnostic: (await this.readStoredKey())
        ? "A Cursor SDK sign-in is stored on this host."
        : MISSING_CREDENTIAL,
    };
  }

  private async fetchModels(signal?: AbortSignal): Promise<SDKModel[]> {
    const timeout = AbortSignal.timeout(30_000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const key = await this.requireApiKey();
    try {
      const models = await this.listModels(key, bounded);
      bounded.throwIfAborted();
      this.catalog = models;
      return models;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CursorSdkAvailabilityError) throw error;
      throw new CursorSdkAvailabilityError("catalog_unavailable");
    }
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

  listCommands(): Promise<AgentSlashCommand[]> {
    // The SDK exposes no slash command catalog. Draft discovery needs no SDK session.
    return Promise.resolve([]);
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
    if (options?.purpose === "history") {
      const sdk = await this.loadSdk();
      return openCursorHistorySession({
        sdk,
        store: this.getBinding(sdk).store,
        journal: new CursorTurnJournal(this.storePath, id),
        handle,
        id,
        model: modelId(overrides?.model),
        mode: MODE,
        modes: MODES,
        capabilities: CAPABILITIES,
      });
    }

    const cwd = await realpath(savedCwd);
    if (overrides?.cwd && (await realpath(overrides.cwd)) !== cwd) {
      throw new Error("Cursor SDK must resume its original workspace.");
    }
    return this.openSession({ ...overrides, provider: PROVIDER, cwd }, launchContext, id);
  }

  private async openSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    nativeId?: string,
  ): Promise<AgentSession> {
    assertNoInheritedAgentIdentity();
    assertMode(config.modeId);
    const apiKey = await this.requireApiKey();
    const cwd = await realpath(config.cwd);
    const sdk = await this.loadSdk();
    const binding = this.getBinding(sdk);
    const { store } = binding;
    if (nativeId) {
      await assertCursorRunReleased(
        store,
        new CursorTurnJournal(this.storePath, nativeId),
        nativeId,
        cwd,
      );
      await clearUnusedCursorReservation(sdk.Agent, store, nativeId, cwd);
    }
    const id = modelId(config.model);
    const providerOptions = config.providerOptions ?? {};
    const controls = await this.getControls(id);
    const options: AgentOptions = {
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

    const agent = nativeId
      ? await sdk.Agent.resume(nativeId, { ...options, apiKey })
      : await sdk.Agent.create({ ...options, apiKey });
    const agentId = agent.agentId;
    return new CursorSdkAgent(
      { agent, apiKey },
      cwd,
      id,
      providerOptions,
      controls,
      (model) => this.getControls(model),
      composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt),
      sdk,
      binding,
      new CursorTurnJournal(this.storePath, agentId),
      {
        read: () => this.requireApiKey(),
        resume: (key, model) => sdk.Agent.resume(agentId, { ...options, apiKey: key, model }),
      },
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

interface CredentialBoundAgent {
  agent: SDKAgent;
  apiKey: string | null;
}

class CursorSdkAgent implements AgentSession {
  readonly provider = PROVIDER;
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private native: CredentialBoundAgent | undefined;
  private readonly runs: CursorRunController;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    native: CredentialBoundAgent,
    private readonly cwd: string,
    private model: string,
    private options: ProviderOptions,
    private modelControls: AgentOptionSelectControl[],
    private readonly getControls: (model: string) => Promise<AgentOptionSelectControl[]>,
    private readonly instructions: string | undefined,
    private readonly sdk: CursorSdk,
    private readonly binding: ReturnType<typeof createCursorRunBinding>,
    private readonly journal: CursorTurnJournal,
    private readonly credentials: {
      read: () => Promise<string>;
      resume: (apiKey: string, model: ModelSelection) => Promise<SDKAgent>;
    },
  ) {
    this.native = native;
    this.id = native.agent.agentId;
    this.runs = new CursorRunController(this.id, journal, (event) => this.emit(event), mapUsage);
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

  private begin(prompt: AgentPromptInput, options?: AgentRunOptions) {
    if (this.closed || this.closing) {
      throw new Error("Cursor SDK session is closing or closed.");
    }
    const input = makePrompt(prompt);
    const text = this.instructions
      ? RUN_INSTRUCTIONS_START + this.instructions + RUN_INSTRUCTIONS_END + input.text
      : input.text;
    return this.runs.start(
      prompt,
      { ...input, text },
      (message, bind, throwIfStopped) => this.sendNative(message, bind, throwIfStopped),
      options?.clientMessageId,
    );
  }

  private async sendNative(
    input: SDKUserMessage,
    bind: (runId: string) => Promise<void>,
    throwIfStopped: () => void,
  ): Promise<Run> {
    throwIfStopped();
    assertNoInheritedAgentIdentity();
    const { store } = this.binding;
    const current = await store.agents.get({ agentId: this.id });
    if (current?.activeRunId) {
      const run = await store.runs.get({ agentId: this.id, runId: current.activeRunId });
      if (!run || run.status === "running" || (run.status === "queued" && run.startedAt != null)) {
        throw new Error(interruptedCursorRunMessage(current.activeRunId));
      }
    }
    const model = selectModel(this.model, this.options, this.modelControls);
    const apiKey = await this.credentials.read();
    let native = this.native;
    if (native?.apiKey !== apiKey) {
      native = await this.rebind(apiKey, model);
      if ((await this.credentials.read()) !== apiKey) {
        throw new Error("Cursor SDK sign-in changed. Send your message again.");
      }
    }
    const { agent } = native;
    return this.binding.send(this.id, bind, () => {
      throwIfStopped();
      return agent.send(input, { model });
    });
  }

  private async rebind(apiKey: string, model: ModelSelection): Promise<CredentialBoundAgent> {
    const { store } = this.binding;
    await assertCursorRunReleased(store, this.journal, this.id, this.cwd);
    await clearUnusedCursorReservation(this.sdk.Agent, store, this.id, this.cwd);
    if (this.native) {
      // Disposal can fail partway. A later turn may retry teardown but cannot send on that handle.
      this.native.apiKey = null;
      await this.native.agent[Symbol.asyncDispose]();
      this.native = undefined;
    }
    const agent = await this.credentials.resume(apiKey, model);
    return (this.native = { agent, apiKey });
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return (await this.begin(prompt, options)).completion;
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const { turnId } = await this.begin(prompt, options);
    return { turnId };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    return this.runs.steer(prompt, options);
  }

  streamHistory(): AsyncGenerator<AgentStreamEvent> {
    return readCursorHistory(this.sdk, this.binding.store, this.journal, this.id);
  }

  listCommands(): Promise<AgentSlashCommand[]> {
    return Promise.resolve([]);
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

  interrupt(): Promise<void> {
    return this.runs.interrupt();
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
      await this.native?.agent[Symbol.asyncDispose]();
    } finally {
      this.listeners.clear();
    }
  }
}
