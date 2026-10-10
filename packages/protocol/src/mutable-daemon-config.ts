import { z } from "zod";
import { ProviderPaseoToolsPolicySchema } from "./provider-config.js";
import { AgentProfileSchema, AgentSkillSelectionSchema } from "./agent-profile.js";
import { TerminalProfileSchema } from "./terminal-profile.js";
import { PluginIdSchema, PluginSourceSchema } from "./plugin-config.js";
import { ReplyRuleSchema } from "./reply-rule.js";

const MutableDaemonProviderModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .passthrough();

const MutableDaemonProviderConfigSchema = z
  .object({
    paseoTools: ProviderPaseoToolsPolicySchema.optional(),
    enabled: z.boolean().optional(),
    additionalModels: z.array(MutableDaemonProviderModelSchema).optional(),
  })
  .passthrough();

const MutableStructuredGenerationProviderSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .passthrough();

const MutableMetadataGenerationConfigSchema = z
  .object({
    providers: z.array(MutableStructuredGenerationProviderSchema).default([]),
  })
  .passthrough();

const MutableBrowserToolsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .passthrough();
const MutableRelayConfigSchema = z
  .object({
    enabled: z.boolean(),
  })
  .passthrough();

export const MutableDaemonConfigSchema = z
  .object({
    // COMPAT(relayConfig): added in v0.2.6, remove after 2027-01-31 when old daemons are unsupported.
    relay: MutableRelayConfigSchema.optional(),
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        injectIntoAgents: z.boolean(),
      })
      .passthrough(),
    hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
    cors: z
      .object({
        allowedOrigins: z.array(z.string()),
      })
      .passthrough()
      .optional(),
    trustedProxies: z.union([z.literal(true), z.array(z.string())]).optional(),
    git: z
      .object({
        maxProcessesPerSecond: z.number().int().positive(),
        maxProcessConcurrency: z.number().int().positive(),
      })
      .optional(),
    app: z.object({ baseUrl: z.string() }).optional(),
    catalogRefreshTimeoutMs: z.number().int().positive().optional(),
    browserTools: MutableBrowserToolsConfigSchema.default({ enabled: false }),
    providers: z.record(z.string(), MutableDaemonProviderConfigSchema).default({}),
    metadataGeneration: MutableMetadataGenerationConfigSchema.default({ providers: [] }),
    autoArchiveAfterMerge: z.boolean().default(false),
    enableTerminalAgentHooks: z.boolean().default(false),
    appendSystemPrompt: z.string().default(""),
    terminalProfiles: z.array(TerminalProfileSchema).optional(),
    agentProfiles: z.array(AgentProfileSchema).optional(),
    skills: z.object({ selection: AgentSkillSelectionSchema.optional() }).strict().optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    replyRules: z.array(ReplyRuleSchema).optional(),
  })
  .passthrough();

export const MutableDaemonConfigPatchSchema = z
  .object({
    relay: MutableRelayConfigSchema.partial().optional(),
    mcp: z.object({ injectIntoAgents: z.boolean().optional() }).passthrough().optional(),
    browserTools: MutableBrowserToolsConfigSchema.partial().optional(),
    providers: z
      .record(z.string(), MutableDaemonProviderConfigSchema.partial().passthrough())
      .optional(),
    removeProviders: z.array(z.string().min(1)).optional(),
    metadataGeneration: MutableMetadataGenerationConfigSchema.partial().optional(),
    autoArchiveAfterMerge: z.boolean().optional(),
    enableTerminalAgentHooks: z.boolean().optional(),
    appendSystemPrompt: z.string().optional(),
    terminalProfiles: z.array(TerminalProfileSchema).optional(),
    agentProfiles: z.array(AgentProfileSchema).optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    replyRules: z.array(ReplyRuleSchema).optional(),
  })
  .partial()
  .passthrough();

export type MutableDaemonConfig = z.infer<typeof MutableDaemonConfigSchema>;
export type MutableDaemonConfigPatch = z.infer<typeof MutableDaemonConfigPatchSchema>;
