import { describe, expect, it } from "vitest";
import { searchPattern } from "@getpaseo/protocol/chat-search-text";
import { overlayMatchParts, splitRunsForMatches, splitTextForMatches } from "./split";

describe("splitTextForMatches", () => {
  it("numbers matches in order and keeps the text between them", () => {
    expect(splitTextForMatches("a Foo b foo", searchPattern("foo"))).toEqual([
      { text: "a ", match: null },
      { text: "Foo", match: 0 },
      { text: " b ", match: null },
      { text: "foo", match: 1 },
    ]);
  });

  it("returns the text unchanged when nothing matches", () => {
    expect(splitTextForMatches("abc", searchPattern("x"))).toEqual([{ text: "abc", match: null }]);
  });
});

describe("splitRunsForMatches", () => {
  it("splits a match that spans runs and keeps each run's fields", () => {
    const runs = [
      { text: "const fo", style: "kw" },
      { text: "o  bar", style: "id" },
    ];
    expect(splitRunsForMatches(runs, searchPattern("foo bar"))).toEqual([
      { text: "const ", style: "kw", match: null },
      { text: "fo", style: "kw", match: 0 },
      { text: "o  bar", style: "id", match: 0 },
    ]);
  });
});

describe("overlayMatchParts", () => {
  it("cuts styled runs at part bounds, including a match that spans runs", () => {
    const runs = [
      { text: "let ab", style: "kw" },
      { text: "c = 1", style: "id" },
    ];
    const parts = splitTextForMatches("let abc = 1\n", searchPattern("abc"));
    expect(overlayMatchParts(runs, parts)).toEqual([
      { text: "let ", style: "kw", match: null },
      { text: "ab", style: "kw", match: 0 },
      { text: "c", style: "id", match: 0 },
      { text: " = 1", style: "id", match: null },
    ]);
  });
});
