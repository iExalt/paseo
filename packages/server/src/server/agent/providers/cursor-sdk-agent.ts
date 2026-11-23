import {
  canRequestCursorShellEnvironment,
  prepareCursorShellEnvironment,
  withCursorShellEnvironment,
} from "./cursor-sdk-shell-environment.js";
import { renderSelectedCursorSkills } from "../cursor-skill-catalog.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentOptions,
  LocalAgentStore,
  ModelSelection,
  Run,
  SDKAgent,
  SDKModel,
  SDKUserMessage,
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
  AgentPermissionResponse,
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
  FetchCatalogOptions,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent-sdk-types.js";
import { openOwnedCursorExecution } from "../execution-owner/cursor-owned-execution.js";
import type { CursorOwnerStart } from "../execution-owner/cursor-owner-worker.js";
import { UnadmittedExecutionError } from "../execution-owner/owned-process.js";
import { supportsExecutionOwner } from "../execution-owner/execution-owner.js";
import { cursorSkillReferences, renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
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
  readCursorLastUsage,
  openCursorHistorySession,
  readCursorHistory,
  interruptedCursorRunMessage,
} from "./cursor-sdk-history.js";
import { assertCursorRunReleased, reconcileReleasedTurn } from "./cursor-sdk-recovery.js";
import { CursorRewindError, forkCursorConversation } from "./cursor-sdk-rewind.js";
import {
  listCursorLocalSessions,
  readCursorLocalSessionForImport,
} from "./cursor-sdk-local-sessions.js";
import { cursorCompactCommand, isCursorCompactPrompt } from "./cursor-sdk-maintenance.js";
import { createCursorRunBinding } from "./cursor-sdk-run-binding.js";
import { CursorForkLinks, withCursorForkBlobs } from "./cursor-sdk-fork-store.js";
import { CursorRunController, type CursorTurnExecution } from "./cursor-sdk-run-controller.js";
import { CursorQuestions, cursorQuestionToolName } from "./cursor-sdk-questions.js";
import { cursorSpeakTool, cursorSpeakToolName } from "./cursor-sdk-voice.js";
import { CursorTurnJournal } from "./cursor-sdk-turn-journal.js";
import { mapCursorUsage } from "./cursor-sdk-telemetry.js";
import {
  cursorCatalogOptionKeys,
  cursorModelLabel,
  cursorOptionsPatch,
  cursorParameterControls,
  cursorReasoningControl,
  cursorSdkModelId,
  defaultCursorModel,
  optionsForCursorControls,
  resolveCursorContextWindowMaxTokens,
  resolveCursorModel,
  resolveCursorOptions,
  selectCursorModel,
} from "./cursor-sdk-model.js";

const MODE = "unrestricted";
const MODES = getAgentProviderDefinition(PROVIDER).modes;
const DEFAULT_MODEL = "auto";
const RUN_INSTRUCTIONS_START = "<paseo_instructions>\n";
const RUN_INSTRUCTIONS_END = "\n</paseo_instructions>\n\n";
const MISSING_CREDENTIAL =
  "Sign in to Cursor SDK in host settings or configure CURSOR_API_KEY on the host.";
const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsOfflineHistory: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsPaseoCli: canRequestCursorShellEnvironment(),
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
};

type CursorSdk = HistorySdk & Pick<typeof import("@cursor/sdk"), "Agent" | "JsonlLocalAgentStore">;
type CursorBinding = ReturnType<typeof createCursorRunBinding> & { links: CursorForkLinks };
type ResolvedCursorModel = SDKModel & { sdkId: string; catalogOptionKeys: Set<string> };

function modelId(id?: string | null): string {
  return id?.trim() || DEFAULT_MODEL;
}

function requestedModelOptions(
  options: ProviderOptions,
  thinking: string | null | undefined,
  controls: AgentOptionSelectControl[],
  strict: boolean,
): ProviderOptions {
  if (thinking === undefined) return options;

  const reasoning = cursorReasoningControl(controls);
  if (!reasoning) {
    if (strict && thinking !== null) {
      throw new Error("This Cursor SDK model does not support a thinking option.");
    }
    return options;
  }
  const value = thinking ?? reasoning.defaultValue ?? null;
  const existing = options[reasoning.key];
  if (existing != null && existing !== value) {
    if (strict) throw new Error("Conflicting Cursor SDK thinking and reasoning settings.");
    return options;
  }
  return { ...options, [reasoning.key]: value };
}

function resolveSessionOptions(
  config: AgentSessionConfig,
  model: ResolvedCursorModel,
  controls: AgentOptionSelectControl[],
  strict: boolean,
): ProviderOptions {
  const merged = config.providerOptions ?? {};
  const own = config.requestedProviderOptions ?? merged;
  // A profile seed can still contain options for a model the draft has left.
  const requested = Object.fromEntries(
    Object.entries(own).filter(
      ([key]) =>
        !model.catalogOptionKeys.has(key) || controls.some((control) => control.key === key),
    ),
  );
  const preferred = config.requestedProviderOptions
    ? resolveCursorOptions(model, controls, merged, false)
    : {};
  return resolveCursorOptions(
    model,
    controls,
    requestedModelOptions(
      requested,
      config.thinkingOptionId?.trim() || undefined,
      controls,
      strict,
    ),
    strict,
    preferred,
  );
}

function assertMode(mode?: string): void {
  if (mode && mode !== MODE) {
    throw new Error("Cursor SDK supports only Unrestricted mode.");
  }
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
            if (block.type === "cursor_skill") return [];
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

  private binding?: CursorBinding;
  private catalog: { apiKey: string; models: SDKModel[] } | undefined;

  constructor(
    private readonly runtimeSettings?: ProviderRuntimeSettings,
    private readonly loadSdk: () => Promise<CursorSdk> = () => import("@cursor/sdk"),
    private readonly listModels = listCursorSdkModels,
    private readonly readStoredKey = readCursorSdkStoredKey,
    private readonly storePath = join(resolvePaseoHome(), "cursor-sdk"),
  ) {}

  private getBinding(sdk: CursorSdk): CursorBinding {
    if (this.binding) return this.binding;
    const links = new CursorForkLinks(this.storePath);
    const store = withCursorForkBlobs(new sdk.JsonlLocalAgentStore(this.storePath), links);
    return (this.binding = { ...createCursorRunBinding(store), links });
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

  private async fetchModels(signal?: AbortSignal, apiKey?: string): Promise<SDKModel[]> {
    const timeout = AbortSignal.timeout(30_000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const key = apiKey ?? (await this.requireApiKey());
    try {
      const models = await this.listModels(key, bounded);
      bounded.throwIfAborted();
      this.catalog = { apiKey: key, models };
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
    const defaultModel = defaultCursorModel(models);
    return {
      models: models.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        aliases: model.aliases,
        label: cursorModelLabel(models, model),
        description: model.description,
        isDefault: model.id === defaultModel?.id,
        isSelectable: cursorSdkModelId(models, model) ? undefined : false,
        contextWindowMaxTokens: resolveCursorContextWindowMaxTokens(model),
        metadata: { parameters: model.parameters, variants: model.variants },
      })),
      modes: MODES,
      defaultModeId: MODE,
    };
  }

  private async resolveModel(id?: string | null, apiKey?: string): Promise<ResolvedCursorModel> {
    const key = apiKey ?? (await this.requireApiKey());
    const models =
      this.catalog?.apiKey === key ? this.catalog.models : await this.fetchModels(undefined, key);
    const model = resolveCursorModel(models, id);
    const sdkId = cursorSdkModelId(models, model);
    if (!sdkId) throw new Error(`Cursor SDK cannot select model "${model.id}" in this catalog.`);
    return { ...model, sdkId, catalogOptionKeys: cursorCatalogOptionKeys(models) };
  }

  listCommands(): Promise<AgentSlashCommand[]> {
    // The SDK exposes no slash command catalog. Draft discovery needs no SDK session.
    return Promise.resolve([]);
  }

  async listControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    const model = await this.resolveModel(config.model);
    const controls = cursorParameterControls(model);
    return {
      model: model.id,
      controls,
      options: resolveSessionOptions(config, model, controls, false),
    };
  }

  async listImportableSessions(options?: ListImportableSessionsOptions) {
    const sdk = await this.loadSdk();
    return listCursorLocalSessions(this.getBinding(sdk).store, options);
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const sdk = await this.loadSdk();
    const { agent, lastRun } = await readCursorLocalSessionForImport(
      this.getBinding(sdk).store,
      input,
    );
    if (!lastRun.model?.id) throw new Error("Cursor SDK could not identify the saved model.");
    const providerOptions = Object.fromEntries(
      (lastRun.model.params ?? []).map(({ id, value }) => ["cursor_model_" + id, value]),
    );
    return importSessionFromPersistence({
      provider: PROVIDER,
      request: { ...input, cwd: agent.cwd },
      context: {
        ...context,
        config: { ...context.config, requestedProviderOptions: providerOptions },
      },
      config: { model: lastRun.model.id, title: agent.name ?? undefined, providerOptions },
      persistence: {
        provider: PROVIDER,
        sessionId: agent.agentId,
        nativeHandle: agent.agentId,
        metadata: { cwd: agent.cwd },
      },
      resumeSession: this.resumeSession.bind(this),
    });
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
        providerOptions: overrides?.providerOptions,
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
    if (config.toolPolicy)
      throw new Error("Cursor SDK cannot preapprove exact MCP tools for unattended execution.");
    const shellEnvironment = await prepareCursorShellEnvironment(
      launchContext?.env,
      dirname(this.storePath),
    );
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
    const model = await this.resolveModel(config.model, apiKey);
    const controls = cursorParameterControls(model);
    const strict = nativeId === undefined;
    const providerOptions = resolveSessionOptions(config, model, controls, strict);
    const options: CursorOwnerStart["options"] = {
      model: selectCursorModel(model.sdkId, providerOptions),
      name: config.title ?? undefined,
      disallowedTools: ["askQuestion"],
      local: {
        cwd,
        settingSources: [],
        sandboxOptions: { enabled: false },
        autoReview: false,
      },
      mcpServers: { ...config.mcpServers, ...launchContext?.mcpServers },
    };

    const nativeOptions = { ...options, local: { ...options.local, store } } satisfies AgentOptions;
    const agent = await withCursorShellEnvironment(shellEnvironment, () =>
      nativeId
        ? sdk.Agent.resume(nativeId, { ...nativeOptions, apiKey })
        : sdk.Agent.create({ ...nativeOptions, apiKey }),
    );
    return new CursorSdkAgent(
      { agent, apiKey },
      cwd,
      model,
      providerOptions,
      controls,
      cursorOptionsPatch(config.providerOptions ?? {}, providerOptions),
      (id, key) => this.resolveModel(id, key),
      composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt),
      sdk,
      binding,
      new CursorTurnJournal(this.storePath, agent.agentId),
      shellEnvironment,
      dirname(this.storePath),
      options,
      launchContext?.paseoTools,
      {
        read: () => this.requireApiKey(),
        resume: (key, selection, id) =>
          withCursorShellEnvironment(shellEnvironment, () =>
            sdk.Agent.resume(id, { ...nativeOptions, apiKey: key, model: selection }),
          ),
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
  readonly capabilities: typeof CAPABILITIES & { supportsVoicePlayback?: boolean };

  private native: CredentialBoundAgent | undefined;
  // Rewind moves the session to a forked local agent.
  private chatId: string;
  private runs: CursorRunController;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly questions = new CursorQuestions((event) => this.emit(event));

  constructor(
    native: CredentialBoundAgent,
    private readonly cwd: string,
    private model: ResolvedCursorModel,
    private options: ProviderOptions,
    private modelControls: AgentOptionSelectControl[],
    readonly openOptionsPatch: ProviderOptions,
    private readonly resolveModel: (
      id?: string | null,
      key?: string,
    ) => Promise<ResolvedCursorModel>,
    private readonly instructions: string | undefined,
    private readonly sdk: CursorSdk,
    private readonly binding: CursorBinding,
    private journal: CursorTurnJournal,
    private readonly shellEnvironment: Awaited<ReturnType<typeof prepareCursorShellEnvironment>>,
    private readonly paseoHome: string,
    private readonly ownedOptions: CursorOwnerStart["options"],
    private readonly voiceTools: AgentLaunchContext["paseoTools"],
    private readonly credentials: {
      read: () => Promise<string>;
      resume: (apiKey: string, model: ModelSelection, agentId: string) => Promise<SDKAgent>;
    },
  ) {
    this.native = native;
    this.chatId = native.agent.agentId;
    this.capabilities = voiceTools?.getTool("speak")
      ? { ...CAPABILITIES, supportsVoicePlayback: true }
      : CAPABILITIES;
    this.runs = this.createRuns();
  }

  get id(): string {
    return this.chatId;
  }

  private createRuns(): CursorRunController {
    const id = this.chatId;
    const journal = this.journal;
    return new CursorRunController(
      id,
      journal,
      (event) => this.emit(event),
      mapCursorUsage,
      (turn, proof) => reconcileReleasedTurn(this.binding.store, journal, id, turn, proof),
    );
  }

  async revertConversation({ messageId }: { messageId: string }): Promise<void> {
    if (this.closed || this.closing) throw new Error("Cursor SDK session is closing or closed.");
    if (this.runs.busy)
      throw new CursorRewindError("Stop the running Cursor SDK turn before rewinding.");
    const { store } = this.binding;
    await assertCursorRunReleased(store, this.journal, this.chatId, this.cwd);
    const fork = await forkCursorConversation({
      sdk: this.sdk,
      store,
      links: this.binding.links,
      journal: this.journal,
      agentId: this.chatId,
      messageId,
    });
    let native: CredentialBoundAgent;
    try {
      // Open the fork before switching so a fork the SDK can't load leaves the chat as it was.
      const apiKey = await this.credentials.read();
      const model = selectCursorModel(this.model.sdkId, this.options);
      native = { agent: await this.credentials.resume(apiKey, model, fork.agentId), apiKey };
    } catch (error) {
      await fork.discard().catch(() => {});
      throw error;
    }
    const previous = this.native;
    this.native = native;
    this.chatId = fork.agentId;
    this.journal = fork.journal;
    this.runs = this.createRuns();
    if (previous) {
      previous.apiKey = null;
      await previous.agent[Symbol.asyncDispose]().catch(() => {});
    }
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
    const resolveSkills = options?.resolveCursorSkills;
    const resolveInstructions = options?.resolveCursorWorkspaceInstructions;
    const blocks = typeof prompt === "string" ? undefined : prompt;
    if (cursorSkillReferences(blocks).length && !resolveSkills) {
      throw new Error("Select Cursor skills again from the skill menu.");
    }
    const input = makePrompt(prompt);
    const requested = { model: this.model, options: this.options };
    return this.runs.start(
      prompt,
      input,
      (message, bind, throwIfStopped, execution) =>
        this.sendNative(
          message,
          requested,
          bind,
          throwIfStopped,
          resolveSkills,
          resolveInstructions,
          execution,
          isCursorCompactPrompt(prompt),
        ),
      options?.clientMessageId,
    );
  }

  private async sendNative(
    input: SDKUserMessage,
    requested: { model: ResolvedCursorModel; options: ProviderOptions },
    bind: (runId: string) => Promise<void>,
    throwIfStopped: () => void,
    resolveSkills: AgentRunOptions["resolveCursorSkills"],
    resolveInstructions: AgentRunOptions["resolveCursorWorkspaceInstructions"],
    execution: CursorTurnExecution,
    compact: boolean,
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
    if (compact && !current?.latestCheckpoint) {
      throw new Error("This Cursor SDK chat has no saved conversation to summarize yet.");
    }
    const apiKey = await this.credentials.read();
    const selected = await this.resolveExactModel(requested.model.id, apiKey);
    const controls = cursorParameterControls(selected);
    const options = resolveCursorOptions(selected, controls, requested.options, true);
    if (Object.keys(cursorOptionsPatch(requested.options, options)).length) {
      throw new Error(
        "Cursor SDK model options changed. Review the settings before sending again.",
      );
    }
    const model = selectCursorModel(selected.sdkId, options);
    execution.setContextWindowMaxTokens(resolveCursorContextWindowMaxTokens(selected, options));
    throwIfStopped();
    const checkDispatch = async () => {
      if ((await this.credentials.read()) !== apiKey) {
        throw new Error("Cursor SDK sign-in changed. Send your message again.");
      }
      throwIfStopped();
    };
    const prepareInput = async (): Promise<SDKUserMessage | null> => {
      throwIfStopped();
      if (compact) {
        await checkDispatch();
        return null;
      }
      const skills = resolveSkills ? await resolveSkills() : undefined;
      const userAndContext = renderSelectedCursorSkills(input.text, skills);
      const workspaceInstructions = await resolveInstructions?.();
      const instructions = composeSystemPromptParts(workspaceInstructions, this.instructions);
      const text = instructions
        ? RUN_INSTRUCTIONS_START + instructions + RUN_INSTRUCTIONS_END + userAndContext
        : userAndContext;
      await checkDispatch();
      return { ...input, text };
    };
    const owned = await this.tryOwnedExecution(execution, throwIfStopped);
    const question = this.questions.tool(execution.interactionSignal);
    const speak = this.voiceTools?.getTool("speak")
      ? cursorSpeakTool(this.id, this.voiceTools, execution.interactionSignal)
      : undefined;
    if (owned) {
      owned.attachQuestionHandler(question.execute, execution.abortInteractions);
      if (speak) owned.attachSpeakHandler(speak.execute);
      owned.attachModelCallHandler(execution.onModelCallCompleted);
    }
    const run = owned
      ? await this.sendOwned(owned, apiKey, model, prepareInput)
      : await this.sendDirect(
          model,
          apiKey,
          prepareInput,
          bind,
          {
            [cursorQuestionToolName]: question,
            ...(speak ? { [cursorSpeakToolName]: speak } : {}),
          },
          compact,
          execution.onModelCallCompleted,
        );
    if (this.model === requested.model && this.options === requested.options) {
      this.model = selected;
      this.modelControls = controls;
    }
    return run;
  }

  private async sendOwned(
    owned: Awaited<ReturnType<typeof openOwnedCursorExecution>>,
    apiKey: string,
    model: ModelSelection,
    prepareInput: () => Promise<SDKUserMessage | null>,
  ): Promise<Run> {
    const env = { ...process.env };
    // The current credential is sent only in the admitted SDK options.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "CURSOR_API_KEY") delete env[key];
    }
    await owned.prepare({
      agentId: this.id,
      options: { ...this.ownedOptions, apiKey, model },
      env,
      shellEnvironment: this.shellEnvironment,
    });
    // Re-read credential and Stop after the worker's potentially async resume.
    return owned.send(await prepareInput());
  }

  private async tryOwnedExecution(execution: CursorTurnExecution, throwIfStopped: () => void) {
    if (!(await supportsExecutionOwner())) return;
    throwIfStopped();
    const { store } = this.binding;
    await assertCursorRunReleased(store, this.journal, this.id, this.cwd);
    const generation = randomUUID();
    await execution.prepareOwner(generation);
    let transitioning = false;
    try {
      const owned = await openOwnedCursorExecution(
        store,
        this.id,
        this.paseoHome,
        generation,
        async (owner, assertLaunchAvailable) => {
          throwIfStopped();
          // The SDK writer remains gated while the existing first-turn
          // reservation is cleared. Failure leaves the new owner unadmitted.
          transitioning = true;
          await clearUnusedCursorReservation(this.sdk.Agent, store, this.id, this.cwd);
          throwIfStopped();
          assertLaunchAvailable();
          await execution.enroll(owner);
        },
        execution.bindRun,
      );
      execution.attachFinish(owned.finish);
      await this.disposeIdleNative();
      return owned;
    } catch (error) {
      if (error instanceof UnadmittedExecutionError) {
        execution.deferUnadmittedCleanup(error.drained);
        throw error;
      }
      // A host can have systemd without sharing the daemon's execution domain.
      // Fall back only before mutating the SDK reservation or enrolling the owner.
      if (transitioning) throw error;
      await execution.discardUnadmittedOwner();
      throwIfStopped();
      return;
    }
  }

  private async sendDirect(
    model: ModelSelection,
    apiKey: string,
    prepareInput: () => Promise<SDKUserMessage | null>,
    bind: (runId: string) => Promise<void>,
    customTools: NonNullable<AgentOptions["local"]>["customTools"],
    compact: boolean,
    onModelCallCompleted: CursorTurnExecution["onModelCallCompleted"],
  ): Promise<Run> {
    // summarize() uses the handle's model, unlike send({ model }).
    const native =
      !compact && this.native?.apiKey === apiKey ? this.native : await this.rebind(apiKey, model);
    return this.binding.send(this.id, bind, async () => {
      const input = await prepareInput();
      if (input === null) {
        return withCursorShellEnvironment(this.shellEnvironment, () => native.agent.summarize());
      }
      return withCursorShellEnvironment(this.shellEnvironment, () =>
        native.agent.send(input, {
          model,
          onDelta: ({ update }) => {
            if (update.type === "model-call-completed") onModelCallCompleted(update.usage);
          },
          local: { customTools },
        }),
      );
    });
  }

  private async resolveExactModel(id: string, apiKey?: string): Promise<ResolvedCursorModel> {
    const model = await this.resolveModel(id, apiKey);
    if (model.id !== id)
      throw new Error(`Cursor SDK model "${id}" is unavailable for this sign-in.`);
    return model;
  }

  private async rebind(apiKey: string, model: ModelSelection): Promise<CredentialBoundAgent> {
    const { store } = this.binding;
    await assertCursorRunReleased(store, this.journal, this.id, this.cwd);
    await clearUnusedCursorReservation(this.sdk.Agent, store, this.id, this.cwd);
    await this.disposeIdleNative();
    const agent = await this.credentials.resume(apiKey, model, this.chatId);
    return (this.native = { agent, apiKey });
  }

  private async disposeIdleNative(): Promise<void> {
    if (!this.native) return;
    // A later turn may retry teardown after a disposal failure. It cannot use this handle.
    this.native.apiKey = null;
    await this.native.agent[Symbol.asyncDispose]();
    this.native = undefined;
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

  async readLastUsage() {
    const usage = await readCursorLastUsage(this.binding.store, this.journal, this.id);
    if (!usage) return undefined;
    const { contextWindowMaxTokens: _storedMax, ...rest } = usage;
    const contextWindowMaxTokens = resolveCursorContextWindowMaxTokens(this.model, this.options);
    return {
      ...rest,
      ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    };
  }

  listCommands(): Promise<AgentSlashCommand[]> {
    return Promise.resolve([cursorCompactCommand]);
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const reasoning = cursorReasoningControl(this.modelControls);
    const thinking = reasoning && this.options[reasoning.key];
    return {
      provider: PROVIDER,
      sessionId: this.id,
      model: this.model.id,
      thinkingOptionId: typeof thinking === "string" ? thinking : null,
      modeId: MODE,
    };
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

  private emitContextWindowMaxIfChanged(previousMax: number | undefined): void {
    const nextMax = resolveCursorContextWindowMaxTokens(this.model, this.options);
    if (nextMax === previousMax) return;
    this.emit({
      type: "usage_updated",
      provider: PROVIDER,
      sessionOnly: true,
      usage: nextMax !== undefined ? { contextWindowMaxTokens: nextMax } : {},
      ...(nextMax === undefined ? { clearContextWindowMax: true } : {}),
    });
  }

  async setModel(id: string | null): Promise<{ model: string; optionsPatch: ProviderOptions }> {
    const previousMax = resolveCursorContextWindowMaxTokens(this.model, this.options);
    const model = await this.resolveModel(id);
    const sameModel = model.id === this.model.id;
    const controls = cursorParameterControls(model);
    const options = resolveCursorOptions(model, controls, sameModel ? this.options : {}, false);
    const patch = cursorOptionsPatch(this.options, options);
    const optionsPatch = sameModel ? patch : { ...patch, ...options };
    this.model = model;
    this.modelControls = controls;
    this.options = options;
    this.emitContextWindowMaxIfChanged(previousMax);
    return { model: model.id, optionsPatch };
  }

  async setThinkingOption(id: string | null): Promise<{ optionsPatch: ProviderOptions }> {
    return { optionsPatch: await this.applyOptions({}, id) };
  }

  async applyOptions(
    patch: ProviderOptions,
    thinkingOptionId?: string | null,
  ): Promise<ProviderOptions> {
    const previousMax = resolveCursorContextWindowMaxTokens(this.model, this.options);
    const model = await this.resolveExactModel(this.model.id);
    const controls = cursorParameterControls(model);
    const requested = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        value ?? controls.find((control) => control.key === key)?.defaultValue ?? null,
      ]),
    );
    const selected = requestedModelOptions(requested, thinkingOptionId, controls, true);
    const previous = optionsForCursorControls(this.options, controls);
    const options = resolveCursorOptions(model, controls, selected, true, previous);
    const applied = cursorOptionsPatch({ ...this.options, ...patch }, options);
    this.model = model;
    this.modelControls = controls;
    this.options = options;
    this.emitContextWindowMaxIfChanged(previousMax);
    return applied;
  }

  getPendingPermissions() {
    return this.questions.requests();
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    this.questions.respond(requestId, response);
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
