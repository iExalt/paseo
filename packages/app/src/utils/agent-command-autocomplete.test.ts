import { describe, expect, it } from "vitest";

import {
  getAutocompleteFallbackIndex,
  orderAutocompleteOptions,
} from "@/components/ui/autocomplete-utils";
import {
  applySlashCommandReplacement,
  applySkillMentionReplacement,
  findActiveSkillMention,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
  cursorTextSkillCommands,
  rewriteSkillTokens,
} from "./agent-command-autocomplete";

describe("filterAndRankCommandAutocompleteEntries", () => {
  const entries = [
    { source: "provider" as const, command: { name: "paseo-committee" } },
    { source: "provider" as const, command: { name: "commit" } },
    { source: "provider" as const, command: { name: "paseo-advisor" } },
  ];

  it("ranks command-name prefixes above later word-boundary partial matches", () => {
    const result = filterAndRankCommandAutocompleteEntries(entries, "comm");

    expect(result.map((entry) => entry.command.name)).toEqual(["commit", "paseo-committee"]);
  });

  it("matches client command aliases", () => {
    const result = filterAndRankCommandAutocompleteEntries(
      [
        { source: "client" as const, command: { name: "exit", aliases: ["quit", "q"] } },
        { source: "client" as const, command: { name: "clear", aliases: ["new"] } },
      ],
      "q",
    );

    expect(result.map((entry) => entry.command.name)).toEqual(["exit"]);
  });
});

describe("filterAndRankCommandAutocompleteEntries on an empty query", () => {
  const rootEntries = [
    { source: "client" as const, command: { name: "exit", aliases: ["quit", "q"] } },
    { source: "client" as const, command: { name: "clear", aliases: ["new"] } },
    { source: "plugin" as const, command: { name: "handoff" } },
    { source: "provider" as const, command: { name: "compact" } },
    { source: "provider" as const, command: { name: "review" } },
  ];

  function selectedOnEnter(query: string) {
    const listed = orderAutocompleteOptions(
      filterAndRankCommandAutocompleteEntries(rootEntries, query),
    );
    return listed[getAutocompleteFallbackIndex(listed.length)]?.command.name;
  }

  it("selects a provider command, never an immediate Paseo action", () => {
    expect(selectedOnEnter("")).toBe("compact");
  });

  it("lists Paseo actions farthest from the input", () => {
    const listed = orderAutocompleteOptions(
      filterAndRankCommandAutocompleteEntries(rootEntries, ""),
    );
    expect(listed.map((entry) => entry.command.name)).toEqual([
      "clear",
      "exit",
      "handoff",
      "review",
      "compact",
    ]);
  });

  it("still selects a typed Paseo action", () => {
    expect(selectedOnEnter("exit")).toBe("exit");
  });

  it("waits for a search when Paseo actions are all there is", () => {
    const clientOnly = rootEntries.filter((entry) => entry.source === "client");

    expect(filterAndRankCommandAutocompleteEntries(clientOnly, "")).toEqual([]);
    expect(
      filterAndRankCommandAutocompleteEntries(clientOnly, "ex").map((entry) => entry.command.name),
    ).toEqual(["exit"]);
  });
});

describe("findActiveSlashCommand", () => {
  it("detects a slash command token in the middle of the prompt", () => {
    const text = "use /tas before implementation";

    expect(
      findActiveSlashCommand({
        text,
        cursorIndex: "use /tas".length,
      }),
    ).toEqual({
      start: 4,
      end: "use /tas".length,
      query: "tas",
      position: "inline",
    });
  });

  it("classifies a slash command token at the prompt start", () => {
    expect(
      findActiveSlashCommand({
        text: "/rew",
        cursorIndex: "/rew".length,
      }),
    ).toEqual({
      start: 0,
      end: "/rew".length,
      query: "rew",
      position: "start",
    });
  });

  it("returns null when the cursor is outside the slash token", () => {
    expect(
      findActiveSlashCommand({
        text: "use /taste now",
        cursorIndex: "use /taste now".length,
      }),
    ).toBeNull();
  });

  it("returns null for slash-delimited paths", () => {
    expect(
      findActiveSlashCommand({
        text: "read /tmp/project",
        cursorIndex: "read /tmp/project".length,
      }),
    ).toBeNull();
  });
});

describe("applySlashCommandReplacement", () => {
  it("replaces only the active slash token", () => {
    const text = "use /tas before implementation";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: "use /tas".length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste before implementation");
  });

  it("commits an inline slash token at the prompt tail", () => {
    const text = "use /tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: text.length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste ");
  });

  it("commits a start slash token at the prompt tail", () => {
    const text = "/tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 0, end: text.length, query: "tas", position: "start" },
        commandName: "taste",
      }),
    ).toBe("/taste ");
  });
});

describe("filterInlineSkillCommandEntries", () => {
  it("keeps provider skills and drops executable commands", () => {
    const entries = [
      { source: "client" as const, command: { name: "clear", kind: "command" } },
      { source: "provider" as const, command: { name: "compact", kind: "command" } },
      { source: "provider" as const, command: { name: "taste", kind: "skill" } },
    ];

    expect(filterInlineSkillCommandEntries(entries).map((entry) => entry.command.name)).toEqual([
      "taste",
    ]);
  });
});

describe("findActiveSkillMention", () => {
  it.each(["$5.00", "echo $HOME", "a$b", '"$"', "$H", "$", "use $", "use\n$skill:docs"])(
    "applies the token-start rule to %s",
    (text) => {
      const valid = text === "$" || text === "use $" || text === "use\n$skill:docs";
      const start = text.lastIndexOf("$");
      expect(findActiveSkillMention({ text, cursorIndex: text.length })).toEqual(
        valid
          ? {
              start,
              end: text.length,
              query: text.slice(start + 1),
              position: start === 0 ? "start" : "inline",
            }
          : null,
      );
    },
  );
  it("uses the cursor and leaves following text intact", () => {
    expect(findActiveSkillMention({ text: "use $docs later", cursorIndex: 9 })).toEqual({
      start: 4,
      end: 9,
      query: "docs",
      position: "inline",
    });
    expect(findActiveSkillMention({ text: "$docs later", cursorIndex: 11 })).toBeNull();
    expect(findActiveSkillMention({ text: "$docs", cursorIndex: -1 })).toBeNull();
  });
});

describe("applySkillMentionReplacement", () => {
  it.each([
    ["codex", "$docs"],
    ["claude", "/docs"],
    ["pi", "/docs"],
    [undefined, "/docs"],
  ])("inserts native syntax for %s", (provider, expected) => {
    expect(
      applySkillMentionReplacement({
        text: "use $do",
        command: { start: 4, end: 7, query: "do", position: "inline" },
        commandName: "docs",
        provider,
      }),
    ).toBe(`use ${expected} `);
  });
  it("preserves the suffix and provider-qualified skill name", () => {
    expect(
      applySkillMentionReplacement({
        text: "$sk later",
        command: { start: 0, end: 3, query: "sk", position: "start" },
        commandName: "skill:docs",
        provider: "pi",
      }),
    ).toBe("/skill:docs later");
  });
});

describe("rewriteSkillTokens", () => {
  const names = new Set(["docs", "plugin:review", "deploy"]);
  const rewrite = (text: string, provider: string | undefined) =>
    rewriteSkillTokens({ text, names, provider });

  it("moves whole known tokens to the target prefix", () => {
    expect(rewrite("$docs then $plugin:review, ok", "claude")).toBe(
      "/docs then /plugin:review, ok",
    );
    expect(rewrite("/docs\n/deploy.", "codex")).toBe("$docs\n$deploy.");
  });

  it("leaves unknown names, longer words, variables, paths, URLs and code alone", () => {
    const text = "$HOME $PATH /usr/bin /deploy-all $Docs a/docs https://x.dev/docs `/docs` $nope";
    expect(rewrite(text, "codex")).toBe(text);
    expect(rewrite("```\n$docs\n```", "claude")).toBe("```\n$docs\n```");
  });

  it("is idempotent and round-trips between providers", () => {
    const codex = "$docs and $deploy; $HOME";
    const claude = rewrite(codex, "claude");
    expect(claude).toBe("/docs and /deploy; $HOME");
    expect(rewrite(claude, "claude")).toBe(claude);
    expect(rewrite(claude, "codex")).toBe(codex);
  });
});

describe("cursorTextSkillCommands", () => {
  const reference = { id: "a".repeat(64), revision: "b".repeat(64), scope: "user" as const };
  const skill = (name: string) => ({
    name,
    description: "",
    argumentHint: "",
    kind: "skill",
    skill: { ...reference, name: "skill-aaaa" },
  });
  const compact = { name: "compact", description: "", argumentHint: "" };
  const commands = [compact, skill("docs"), skill("Code Review"), skill("compact")];

  it("lists Cursor skills as plain text skills when the host expands /name", () => {
    expect(cursorTextSkillCommands(commands, true)).toEqual([
      compact,
      { name: "docs", description: "", argumentHint: "", kind: "skill" },
    ]);
  });

  it("hides Cursor skills from a host that cannot expand text", () => {
    expect(cursorTextSkillCommands(commands, false)).toEqual([compact]);
  });
});
