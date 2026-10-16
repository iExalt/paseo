import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { countMatches, searchableBlocks, searchPattern } from "@getpaseo/protocol/chat-search-text";
import type { ASTNode } from "react-native-markdown-display";
import parser from "react-native-markdown-display/src/lib/parser";
import { isFindMarkedNode } from "@/find-highlight/markdown-nodes";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";
import { findMarkdownMatches } from "./markdown-matches";

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

const assistantMarkdownIt = createAssistantMarkdownParser();

function nodesByKey(block: string): Map<string, ASTNode> {
  const nodes = new Map<string, ASTNode>();
  const visit = (node: ASTNode) => {
    nodes.set(node.key, node);
    for (const child of node.children) visit(child);
  };
  for (const node of parser(block, (ast) => ast, assistantMarkdownIt)) visit(node);
  return nodes;
}

describe("findMarkdownMatches", () => {
  it("numbers every match the host counts, once each, in reading order", () => {
    const { count, blocks } = findMarkdownMatches(MIXED, searchPattern("find"));
    expect(count).toBe(hostCount(MIXED, "find"));
    const emitted = blocks
      .flatMap((parts) => [...parts.values()].flat())
      .flatMap((part) => (part.match === null ? [] : [part.match]));
    expect([...new Set(emitted)]).toEqual([...Array(count).keys()]);
  });

  it("numbers a match that spans bold edges and a line break once, on every piece", () => {
    const { count, blocks } = findMarkdownMatches(
      "say **hello\nthere** now",
      searchPattern("hello there"),
    );
    expect(count).toBe(1);
    const pieces = [...blocks[0]!.values()].flat().filter((part) => part.match !== null);
    expect(pieces.map((part) => part.text)).toEqual(["hello", "there"]);
    expect(pieces.every((part) => part.match === 0)).toBe(true);
  });

  it("keeps node keys per rendered block, which repeat across blocks", () => {
    const { blocks } = findMarkdownMatches("first x\n\nsecond x", searchPattern("x"));
    expect(blocks).toHaveLength(2);
    const [firstKeys, secondKeys] = blocks.map((parts) => [...parts.keys()]);
    expect(firstKeys).toEqual(secondKeys);
    expect(blocks[1]!.get(secondKeys![0]!)!.find((part) => part.match !== null)!.match).toBe(1);
  });

  it("numbers only nodes the message rules mark, and nothing in a diagram", () => {
    const text = [
      "find [the `find` link](https://x.dev) and `src/find.ts` and `https://find.dev`",
      "",
      "```mermaid",
      "graph TD; find --> find",
      "```",
    ].join("\n");
    const { count, blocks } = findMarkdownMatches(text, searchPattern("find"));
    expect(count).toBe(4);
    splitMarkdownBlocks(text).forEach((block, index) => {
      const nodes = nodesByKey(block);
      for (const key of blocks[index]!.keys()) {
        expect(isFindMarkedNode(nodes.get(key)!), key).toBe(true);
      }
    });
  });
});
