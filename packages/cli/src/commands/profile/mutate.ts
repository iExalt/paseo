import { randomUUID } from "node:crypto";
import {
  AgentProfileSchema,
  assertRemoteProfileFeatures,
  type AgentProfile,
} from "@getpaseo/protocol/agent-profile";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";

export async function mutateProfile(
  action: "add" | "update" | "rm",
  id: string | undefined,
  raw: string | undefined,
  options: CommandOptions,
) {
  const input = raw === undefined ? undefined : JSON.parse(raw);
  if (action !== "rm" && (!input || typeof input !== "object" || Array.isArray(input)))
    throw new Error("Profile configuration must be a JSON object");
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(profileCompare): added in v0.27.0, remove gate after 2027-05-14 once daemon floor supports comparison.
    if (client.getLastServerInfoMessage()?.features?.daemonConfigCompare !== true)
      throw new Error("Update the host to edit profiles safely");
    const { profiles } = await client.listAgentProfiles();
    const { profile, next } = prepareProfileMutation(action, id, input, profiles);
    await client.editDaemonConfig("agentProfiles", { value: next, expectedValue: profiles });
    const data = { action, profile };
    return {
      type: "single" as const,
      data,
      schema: {
        idField: () => profile.id,
        columns: [],
        renderHuman: () => JSON.stringify(data, null, 2),
      },
    };
  } finally {
    await client.close();
  }
}

function prepareProfileMutation(
  action: "add" | "update" | "rm",
  id: string | undefined,
  input: Record<string, unknown> | undefined,
  profiles: AgentProfile[],
) {
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error("Duplicate saved profile IDs; repair host settings before editing");
  const found = profiles.find((profile) => profile.id === id);
  if (action !== "add" && !found) throw new Error(`Unknown profile: ${id}`);
  if (action === "update" && input?.id !== undefined && input.id !== id)
    throw new Error("A profile update cannot change its ID");
  const profile =
    action === "rm"
      ? found!
      : AgentProfileSchema.strict()
          .extend({
            id: AgentProfileSchema.shape.id.min(1),
            name: AgentProfileSchema.shape.name.trim().min(1),
            provider: AgentProfileSchema.shape.provider.trim().min(1),
          })
          .parse(action === "add" ? { id: randomUUID(), ...input } : { ...found, ...input });
  if (action !== "rm") assertRemoteProfileFeatures(profile.featureValues);
  if (action === "add" && profiles.some((entry) => entry.id === profile.id))
    throw new Error(`Profile already exists: ${profile.id}`);
  let next: AgentProfile[];
  if (action === "add") next = [...profiles, profile];
  else if (action === "rm") next = profiles.filter((entry) => entry.id !== id);
  else next = profiles.map((entry) => (entry.id === id ? profile : entry));
  return { profile, next };
}
