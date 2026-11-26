import type { QueryClient } from "@tanstack/react-query";
import { isCursorSkillTokenName } from "@getpaseo/protocol/messages";
import type { AgentSlashCommand } from "@/agent-commands";
import { agentCommandsQueryRoot, normalizeAgentCommandsCwd } from "@/agent-commands/cache";
import type { UserComposerAttachment } from "@/attachments/types";
import { rewriteSkillTokens, skillTokenPrefix } from "@/utils/agent-command-autocomplete";

export interface ProviderSkillCatalog {
  /** Names of the skills the provider listed. */
  names: ReadonlySet<string>;
  /** Cursor SDK skill names by reference id, for drafts that still hold skill chips. */
  cursorNamesById: ReadonlyMap<string, string>;
}

/**
 * The skills a provider listed for this checkout, from commands already fetched. Nothing is
 * fetched: a provider whose commands never loaded lists no skills.
 */
export function readCachedProviderSkills(
  queryClient: QueryClient,
  input: { serverId: string; provider: string; cwd: string },
): ProviderSkillCatalog {
  const cwd = normalizeAgentCommandsCwd(input.cwd);
  const names = new Set<string>();
  const cursorNamesById = new Map<string, string>();
  const queries = queryClient.getQueryCache().findAll({
    queryKey: agentCommandsQueryRoot(input.serverId),
    predicate: (query) =>
      query.meta?.agentCommandProvider === input.provider &&
      typeof query.meta?.agentCommandCwd === "string" &&
      normalizeAgentCommandsCwd(query.meta.agentCommandCwd) === cwd,
  });
  for (const query of queries) {
    const commands = query.state.data;
    if (!Array.isArray(commands)) continue;
    for (const command of commands as AgentSlashCommand[]) {
      if (command.kind !== "skill") continue;
      names.add(command.name);
      if (command.skill) cursorNamesById.set(command.skill.id, command.name);
    }
  }
  return { names, cursorNamesById };
}

/**
 * Carries a draft's skills to another provider: `$name` and `/name` tokens for skills the previous
 * provider listed take the new provider's prefix, and Cursor skill chips become tokens when the
 * new provider is not Cursor SDK. A chip whose name is unknown stays, and sending explains it.
 */
export function carryDraftSkillsToProvider(input: {
  text: string;
  attachments: readonly UserComposerAttachment[];
  previous: ProviderSkillCatalog;
  provider: string;
}): { text: string; attachments: UserComposerAttachment[] } {
  let text = rewriteSkillTokens({
    text: input.text,
    names: input.previous.names,
    provider: input.provider,
  });
  if (input.provider === "cursor-sdk") return { text, attachments: [...input.attachments] };
  const tokens: string[] = [];
  const attachments = input.attachments.filter((attachment) => {
    if (attachment.kind !== "skill") return true;
    const name = input.previous.cursorNamesById.get(attachment.reference.id);
    if (!name || !isCursorSkillTokenName(name)) return true;
    tokens.push(`${skillTokenPrefix(input.provider)}${name}`);
    return false;
  });
  if (tokens.length) text = placeSkillTokens(text, tokens.join(" "));
  return { text, attachments };
}

// A leading slash command keeps its place, so the skills follow it; otherwise they lead the text.
function placeSkillTokens(text: string, tokens: string): string {
  if (!text) return `${tokens} `;
  if (!/^[/$]/.test(text)) return `${tokens} ${text}`;
  return /\s$/.test(text) ? `${text}${tokens}` : `${text} ${tokens}`;
}
