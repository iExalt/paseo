import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { countMatches, searchableBlocks, searchPattern } from "@getpaseo/protocol/chat-search-text";
import { splitMarkdownForFind } from "@/components/markdown/find-split";
import { findMarkdownMatches, highlightMarkdown } from "./markdown-matches";

const MIXED = [
  "# Find heading",
  "",
  "A **find** in bold, `find` in code, [a find link](https://x.dev) and find",
  "across a soft  ",
  "break: find",
  "",
  "- find in a list",
  "  - nested find",
  "",
  "| col | find |",
  "| --- | ---- |",
  "| find | x |",
  "",
  "```ts",
  "const find = 1; // find",
  "```",
  "",
  "![find alt](https://x.dev/a.png) after find",
].join("\n");

function hostCount(text: string, query: string): number {
  const pattern = searchPattern(query);
  return searchableBlocks(new MarkdownIt({ html: false }).parse(text, {})).reduce(
    (total, block) => total + countMatches(block, pattern),
    0,
  );
}

function marked(text: string, query: string, occurrence: number): string {
  const match = findMarkdownMatches(text, searchPattern(query)).matches[occurrence]!;
  return match.kind === "inline" ? highlightMarkdown(text, match.marks) : "";
}

describe("findMarkdownMatches", () => {
  it("counts every match the host counts, in reading order", () => {
    const { count, matches } = findMarkdownMatches(MIXED, searchPattern("find"));
    expect(count).toBe(hostCount(MIXED, "find"));
    const kinds = matches.map((match) => match.kind);
    expect(kinds.filter((kind) => kind === "code")).toHaveLength(2);
    expect(kinds.lastIndexOf("code")).toBe(kinds.length - 2);
  });

  it("highlights text, a code span whole, and a match across bold edges and a break", () => {
    expect(marked("one find here", "find", 0)).toBe("one ==find== here");
    expect(marked("see `a find` too", "find", 0)).toBe("see ==`a find`== too");
    expect(marked("say **hello\nthere** now", "hello there", 0)).toBe(
      "say **==hello\nthere==** now",
    );
  });

  it("keeps escapes inside a mark and escapes every other equals sign", () => {
    expect(marked("a == b and \\*find\\* x=1", "*find*", 0)).toBe(
      "a \\=\\= b and ==\\*find\\*== x\\=1",
    );
  });

  it("drops whitespace at a piece's edge, which a delimiter cannot hug", () => {
    expect(marked("go find **it** now", "find it", 0)).toBe("go ==find== **==it==** now");
  });

  it("counts nothing in a diagram and never marks image alt text", () => {
    const text = ["![find](x.png) find", "", "```mermaid", "graph TD; find --> find", "```"].join(
      "\n",
    );
    const { count } = findMarkdownMatches(text, searchPattern("find"));
    expect(count).toBe(1);
    expect(marked(text, "find", 0).split("\n")[0]).toBe("![find](x.png) ==find==");
  });
});

describe("splitMarkdownForFind", () => {
  it("draws the block holding the match apart and places the match in it", () => {
    const text = "intro\n\npara with find inside\n\noutro";
    const match = findMarkdownMatches(text, searchPattern("find")).matches[0]!;
    const split = splitMarkdownForFind(text, match);
    expect(split).toMatchObject({
      head: "intro\n\n",
      block: "para with ==find== inside\n\n",
      tail: "outro",
      code: null,
    });
    expect(split.fraction).toBeCloseTo(10 / "para with find inside\n\n".length);
  });

  it("draws a code block in place of the fence, numbered within the code", () => {
    const text = "find\n\n```ts\nfind(); find();\n```\n";
    const match = findMarkdownMatches(text, searchPattern("find")).matches[2]!;
    const split = splitMarkdownForFind(text, match);
    expect(split.head).toBe("find\n\n");
    expect(split.tail).toBe("");
    expect(split.code).toMatchObject({ code: "find(); find();", language: "ts", current: 1 });
  });

  it("keeps a message with definitions whole, so references still resolve", () => {
    const text = "see [ref] find\n\n```\nfind\n```\n\n[ref]: https://x.dev";
    const { matches } = findMarkdownMatches(text, searchPattern("find"));
    expect(matches.map((match) => match.block)).toEqual([
      { start: 0, end: text.length },
      { start: 0, end: text.length },
    ]);
    // Code drawn natively cannot be marked, but the occurrence still counts.
    expect(matches[1]).toEqual({ kind: "inline", block: matches[1]!.block, marks: [] });
  });
});
