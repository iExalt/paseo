import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { draftAgentCommandsQueryKey } from "@/agent-commands/cache";
import { carryDraftSkillsToProvider, readCachedProviderSkills } from "./provider-switch-skills";

const id = (char: string) => char.repeat(64);

function chip(name: string, idChar: string): UserComposerAttachment {
  return {
    kind: "skill",
    reference: { name, scope: "user", id: id(idChar), revision: id("f") },
  };
}

function cache(provider: string, commands: unknown[], cwd = "/repo") {
  const queryClient = new QueryClient();
  queryClient
    .getQueryCache()
    .build(queryClient, {
      queryKey: draftAgentCommandsQueryKey({ serverId: "host", draftConfig: { provider, cwd } }),
      meta: { agentCommandProvider: provider, agentCommandCwd: cwd },
    })
    .setData(commands);
  return queryClient;
}

describe("readCachedProviderSkills", () => {
  it("reads only the previous provider's fetched skills for this checkout", () => {
    const queryClient = cache("codex", [
      { name: "docs", kind: "skill" },
      { name: "compact", kind: "command" },
    ]);
    expect(
      readCachedProviderSkills(queryClient, { serverId: "host", provider: "codex", cwd: "/repo/" })
        .names,
    ).toEqual(new Set(["docs"]));
    expect(
      readCachedProviderSkills(queryClient, { serverId: "host", provider: "claude", cwd: "/repo" })
        .names.size,
    ).toBe(0);
  });
});

describe("carryDraftSkillsToProvider", () => {
  it("turns Codex skill text into Cursor /name tokens on a switch to Cursor SDK", () => {
    const previous = readCachedProviderSkills(
      cache("codex", [{ name: "brev-cli", kind: "skill" }]),
      {
        serverId: "host",
        provider: "codex",
        cwd: "/repo",
      },
    );
    expect(
      carryDraftSkillsToProvider({
        text: "$brev-cli $HOME",
        attachments: [],
        previous,
        provider: "cursor-sdk",
      }).text,
    ).toBe("/brev-cli $HOME");
  });

  it("turns Cursor skill chips into the new provider's tokens by catalog name", () => {
    const previous = {
      names: new Set(["plugin:review"]),
      cursorNamesById: new Map([
        [id("a"), "plugin:review"],
        [id("b"), "Code Review"],
      ]),
    };
    const attachments = [chip("review", "a"), chip("skill-bbbb", "b"), chip("gone", "c")];
    expect(
      carryDraftSkillsToProvider({ text: "fix it", attachments, previous, provider: "codex" }),
    ).toEqual({ text: "$plugin:review fix it", attachments: attachments.slice(1) });
    expect(
      carryDraftSkillsToProvider({ text: "/compact", attachments, previous, provider: "claude" })
        .text,
    ).toBe("/compact /plugin:review");
    expect(
      carryDraftSkillsToProvider({ text: "", attachments, previous, provider: "cursor-sdk" }),
    ).toEqual({ text: "", attachments });
  });
});
