import { expect, it } from "vitest";
import {
  cursorSkillPromptText,
  cursorSkillTokenCandidates,
  matchCursorSkillTokens,
  preferredCursorSkills,
} from "./cursor-skill-tokens.js";

function skill(name: string, scope: "workspace" | "user" = "workspace", id = `${scope}:${name}`) {
  return { name, reference: { id, scope } };
}

const catalog = [
  skill("deploy"),
  skill("docs"),
  skill("plugin:review"),
  skill("Code Review"),
  skill("usr"),
];

function names(text: string, skills = catalog) {
  return matchCursorSkillTokens(text, skills).map(({ name }) => name);
}

it("selects whole /name tokens at the start or after whitespace, once each", () => {
  expect(names("/deploy now, then /docs and /deploy again")).toEqual(["deploy", "docs"]);
  expect(names("run\n/plugin:review")).toEqual(["plugin:review"]);
  expect(names("unknown /deployment /nope stays text")).toEqual([]);
});

it("strips trailing punctuation only until a catalog name matches", () => {
  expect(cursorSkillTokenCandidates("(/docs).")).toEqual([]);
  expect(cursorSkillTokenCandidates("see /docs).")).toEqual([["docs).", "docs)", "docs"]]);
  expect(names("see /docs).")).toEqual(["docs"]);
  expect(names("/deploy: now")).toEqual(["deploy"]);
  expect(names("/plugin:review.")).toEqual(["plugin:review"]);
  expect(names("/deploy:", [skill("deploy:")])).toEqual([]);
  expect(names("/deploy;")).toEqual(["deploy"]);
});

it("never reads paths, URLs, mid-word slashes, code or names text cannot spell", () => {
  expect(names("ls /usr/bin and https://x.dev/docs and a/docs")).toEqual([]);
  expect(names("`/deploy` and\n```\n/docs\n```")).toEqual([]);
  expect(names("```\n/docs")).toEqual([]);
  expect(names("/Code Review")).toEqual([]);
  expect(names("$deploy")).toEqual([]);
});

it("prefers a workspace skill over a user skill of the same name", () => {
  const user = skill("deploy", "user");
  const workspace = skill("deploy", "workspace");
  expect(preferredCursorSkills([user, workspace])).toEqual([workspace]);
  expect(preferredCursorSkills([workspace, user])).toEqual([workspace]);
  expect(matchCursorSkillTokens("/deploy", [user, workspace])).toEqual([workspace]);
  const first = skill("docs", "user", "first");
  expect(preferredCursorSkills([first, skill("docs", "user", "second")])).toEqual([first]);
});

it("reads only the text the user typed", () => {
  expect(cursorSkillPromptText("/deploy")).toBe("/deploy");
  expect(
    cursorSkillPromptText([
      { type: "text", text: "/deploy" },
      { type: "text", text: "/docs", mimeType: "text/plain" },
      { type: "text", text: "/docs", mimeType: "text/plain", contextKind: "chat_history" },
    ]),
  ).toBe("/deploy");
});
