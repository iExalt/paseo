import {
  isCursorSkillTokenName,
  SKILL_TOKEN_TRAILING_PUNCTUATION,
  splitSkillTokenCode,
} from "@getpaseo/protocol/messages";
import {
  compareMatchScores,
  type MatchScore,
  scoreTextFields,
} from "@getpaseo/protocol/search/text-match";

type CommandAutocompleteSource = "provider" | "plugin" | "client";

interface CommandAutocompleteEntry {
  source: CommandAutocompleteSource;
  command: {
    name: string;
    aliases?: readonly string[];
    kind?: string;
  };
}

// The list renders reversed above the input with the first entry selected. Paseo's own actions
// run at once (`/exit` archives), so an empty query never selects one: they sort farthest from
// the input, and with nothing else to list the menu waits for a search.
const EMPTY_QUERY_SOURCE_ORDER: Record<CommandAutocompleteSource, number> = {
  provider: 0,
  plugin: 1,
  client: 2,
};

export type SlashCommandPosition = "start" | "inline";

export interface SlashCommandRange {
  start: number;
  end: number;
  query: string;
  position: SlashCommandPosition;
}

interface FindActiveSlashCommandInput {
  text: string;
  cursorIndex: number;
}

interface ApplySlashCommandReplacementInput {
  text: string;
  command: SlashCommandRange;
  commandName: string;
}

interface ScoredCommandAutocompleteEntry<TEntry> {
  entry: TEntry;
  score: MatchScore;
}

function scoreCommandAutocompleteEntry(
  entry: CommandAutocompleteEntry,
  query: string,
): MatchScore | null {
  return scoreTextFields(query, [entry.command.name, ...(entry.command.aliases ?? [])]);
}

export function filterAndRankCommandAutocompleteEntries<TEntry extends CommandAutocompleteEntry>(
  entries: readonly TEntry[],
  query: string,
): TEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    if (entries.every((entry) => entry.source === "client")) return [];
    // Hermes has no `toSorted`.
    return [...entries].sort(
      (a, b) => EMPTY_QUERY_SOURCE_ORDER[a.source] - EMPTY_QUERY_SOURCE_ORDER[b.source],
    );
  }

  const scoredEntries: ScoredCommandAutocompleteEntry<TEntry>[] = [];
  for (const entry of entries) {
    const score = scoreCommandAutocompleteEntry(entry, normalizedQuery);
    if (score) {
      scoredEntries.push({ entry, score });
    }
  }

  scoredEntries.sort((a, b) => {
    const scoreComparison = compareMatchScores(a.score, b.score);
    if (scoreComparison !== 0) {
      return scoreComparison;
    }
    return a.entry.command.name.localeCompare(b.entry.command.name);
  });

  return scoredEntries.map((scored) => scored.entry);
}

export function filterInlineSkillCommandEntries<TEntry extends CommandAutocompleteEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  return entries.filter((entry) => entry.source === "provider" && entry.command.kind === "skill");
}

const INVALID_SLASH_COMMAND_QUERY_CHARS = /[/\s\n\r\t"']/;

export function findActiveSlashCommand(
  input: FindActiveSlashCommandInput,
): SlashCommandRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);

  for (
    let slashIndex = beforeCursor.lastIndexOf("/");
    slashIndex >= 0;
    slashIndex = slashIndex === 0 ? -1 : beforeCursor.lastIndexOf("/", slashIndex - 1)
  ) {
    const previousCharacter = slashIndex > 0 ? input.text[slashIndex - 1] : "";
    if (previousCharacter && !/\s/.test(previousCharacter)) {
      continue;
    }

    const query = beforeCursor.slice(slashIndex + 1);
    if (INVALID_SLASH_COMMAND_QUERY_CHARS.test(query)) {
      continue;
    }

    return {
      start: slashIndex,
      end: clampedCursor,
      query,
      position: slashIndex === 0 ? "start" : "inline",
    };
  }

  return null;
}

export function applySlashCommandReplacement(input: ApplySlashCommandReplacementInput): string {
  const before = input.text.slice(0, input.command.start);
  const after = input.text.slice(input.command.end);
  const replacement = `${before}/${input.commandName}${after}`;
  return input.command.end === input.text.length ? `${replacement} ` : replacement;
}

export function findActiveSkillMention(
  input: FindActiveSlashCommandInput,
): SlashCommandRange | null {
  const cursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, cursor);
  const start = beforeCursor.lastIndexOf("$");
  if (start < 0 || (start > 0 && !/\s/.test(input.text[start - 1]))) return null;
  const query = beforeCursor.slice(start + 1);
  // Uppercase-leading tokens belong to shell variables, including while the user types them.
  if (query !== "" && !/^[a-z][a-zA-Z0-9:_-]*$/.test(query)) return null;
  return { start, end: cursor, query, position: start === 0 ? "start" : "inline" };
}

export function applySkillMentionReplacement(
  input: ApplySlashCommandReplacementInput & { provider: string | undefined },
): string {
  if (input.provider !== "codex") return applySlashCommandReplacement(input);
  const before = input.text.slice(0, input.command.start);
  const after = input.text.slice(input.command.end);
  const replacement = `${before}$${input.commandName}${after}`;
  return input.command.end === input.text.length ? `${replacement} ` : replacement;
}

/** The prefix a provider reads a skill token by: Codex uses `$name`, the others `/name`. */
export function skillTokenPrefix(provider: string | undefined): "$" | "/" {
  return provider === "codex" ? "$" : "/";
}

/**
 * Rewrites whole `$name` and `/name` tokens to the target provider's prefix when `name` is one of
 * `names`. Tokens start the text or follow whitespace; code, paths, URLs and shell variables stay
 * as typed.
 */
export function rewriteSkillTokens(input: {
  text: string;
  names: ReadonlySet<string>;
  provider: string | undefined;
}): string {
  if (input.names.size === 0) return input.text;
  const prefix = skillTokenPrefix(input.provider);
  return splitSkillTokenCode(input.text)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/(^|\s)[$/](\S+)/g, (token, lead: string, word: string) => {
            for (let name = word; name; name = name.slice(0, -1)) {
              if (input.names.has(name)) return `${lead}${prefix}${name}${word.slice(name.length)}`;
              if (!SKILL_TOKEN_TRAILING_PUNCTUATION.test(name)) break;
            }
            return token;
          }),
    )
    .join("");
}

/**
 * Cursor SDK skills come from the daemon's catalog with a reference. A host that expands `/name`
 * text lists them as plain skill commands, so choosing one inserts text. Skills whose name text
 * cannot spell, skills a same-name command shadows (the daemon runs the command), and every Cursor
 * skill on an older host stay out of the menu.
 */
export function cursorTextSkillCommands<TCommand extends { name: string; skill?: unknown }>(
  commands: readonly TCommand[],
  hostExpandsText: boolean,
): TCommand[] {
  const commandNames = new Set(
    commands.filter((command) => !command.skill).map((command) => command.name),
  );
  return commands.flatMap((command) => {
    if (!command.skill) return [command];
    if (
      !hostExpandsText ||
      !isCursorSkillTokenName(command.name) ||
      commandNames.has(command.name)
    ) {
      return [];
    }
    const { skill: _skill, ...textCommand } = command;
    return [textCommand as TCommand];
  });
}
