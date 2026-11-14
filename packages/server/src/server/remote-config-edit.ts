import { z } from "zod";
import { PersistedConfigSchema, type PersistedConfig } from "./persisted-config.js";
import { ProviderOverridesSchema } from "@getpaseo/protocol/provider-config";

export const REMOTE_CONFIG_PATHS: Record<string, string> = {
  usage: "daemon.usage",
  browserTools: "daemon.browserTools",
  autoArchiveAfterMerge: "daemon.autoArchiveAfterMerge",
  enableTerminalAgentHooks: "daemon.enableTerminalAgentHooks",
  appendSystemPrompt: "daemon.appendSystemPrompt",
  terminalProfiles: "daemon.terminalProfiles",
  agentProfiles: "daemon.agentProfiles",
  idleRuntimeCleanup: "agents.idleRuntimeCleanup",
  resumeOnStartup: "agents.resumeOnStartup",
  resumePrompt: "agents.resumePrompt",
  providers: "agents.providers",
  metadataGeneration: "agents.metadataGeneration",
  skills: "agents.skills",
  pluginsEnabled: "pluginsEnabled",
  replyRules: "replyRules",
  features: "features",
};

function unwrap(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    return unwrap(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodPipe)
    return unwrap(
      (schema.in instanceof z.ZodUnknown || schema.in instanceof z.ZodTransform
        ? schema.out
        : schema.in) as z.ZodType,
    );
  return schema;
}

// Passthrough wire schemas must not turn unknown edit keys into permanent configuration.
function validateKeys(schema: z.ZodType, value: unknown): void {
  schema = unwrap(schema);
  if (
    schema instanceof z.ZodObject &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(schema.shape, key)) throw new Error(`Unknown configuration key: ${key}`);
      validateKeys(schema.shape[key], entry);
    }
  } else if (schema instanceof z.ZodRecord && value && typeof value === "object") {
    for (const entry of Object.values(value)) validateKeys(schema.valueType as z.ZodType, entry);
  } else if (schema instanceof z.ZodArray && Array.isArray(value)) {
    for (const entry of value) validateKeys(schema.element as z.ZodType, entry);
  }
}

export function editRemoteConfig(
  persisted: PersistedConfig,
  field: string,
  edit: { value?: unknown; unset?: boolean },
): { persisted: PersistedConfig; root: string } {
  const parts = field.split(".");
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part)))
    throw new Error("Invalid configuration path");
  const root = parts[0]!;
  if (!Object.hasOwn(REMOTE_CONFIG_PATHS, root))
    throw new Error(`Configuration area is local/UI only: ${root}`);
  if (root === "features" && !["dictation", "voiceMode"].includes(parts[1] ?? ""))
    throw new Error("Edit features.dictation or features.voiceMode separately");
  const persistedParts = [...REMOTE_CONFIG_PATHS[root]!.split("."), ...parts.slice(1)];
  const schema = schemaAtPath(persistedParts);
  if (!edit.unset) {
    validateKeys(schema, edit.value);
    schema.parse(edit.value);
  }
  const next = structuredClone(persisted) as Record<string, unknown>;
  let object = next;
  for (const part of persistedParts.slice(0, -1)) {
    object[part] ??= {};
    const child = object[part];
    if (!child || typeof child !== "object" || Array.isArray(child))
      throw new Error(`Not an object: ${field}`);
    object = child as Record<string, unknown>;
  }
  const key = persistedParts.at(-1)!;
  if (edit.unset) delete object[key];
  else object[key] = edit.value;
  const checked = PersistedConfigSchema.parse(next);
  if (root === "providers") ProviderOverridesSchema.parse(checked.agents?.providers ?? {});
  if (root === "agentProfiles")
    for (const profile of checked.daemon?.agentProfiles ?? [])
      validateProfileFeatures(profile.featureValues);

  return { persisted: checked as PersistedConfig, root };
}

function validateProfileFeatures(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      ["agentTools", "envOverrides", "hostnames", "cors", "trustedProxies", "relay", "mcp"].some(
        (blocked) => key.split(".").includes(blocked),
      )
    )
      throw new Error(`Profile feature is local/UI only: ${key}`);
    validateProfileFeatures(child);
  }
}

function schemaAtPath(parts: string[]): z.ZodType {
  let schema: z.ZodType = PersistedConfigSchema;
  for (const part of parts) {
    schema = unwrap(schema);
    if (schema instanceof z.ZodObject && Object.hasOwn(schema.shape, part))
      schema = schema.shape[part];
    else if (schema instanceof z.ZodRecord) schema = schema.valueType as z.ZodType;
    else throw new Error(`Unknown configuration path: ${parts.join(".")}`);
  }
  return schema;
}
