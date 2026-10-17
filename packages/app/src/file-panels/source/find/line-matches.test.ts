import { describe, expect, it } from "vitest";
import { expandTabs } from "../source/line-layout";
import { FILE_FIND_MATCH_LIMIT, findLineMatches } from "./line-matches";

describe("findLineMatches", () => {
  it("matches literally and ignores case, including outside ASCII", () => {
    expect(findLineMatches(["a.b A.B axb"], "a.b").matches).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
    ]);
    expect(findLineMatches(["Été", "été"], "ÉTÉ").matches.map((match) => match.line)).toEqual([
      0, 1,
    ]);
  });

  it("never matches across lines or for an empty or multi-line query", () => {
    expect(findLineMatches(["foo", "bar"], "o\nb").matches).toEqual([]);
    expect(findLineMatches(["foo"], "").matches).toEqual([]);
  });

  it("points into tab-expanded lines", () => {
    expect(findLineMatches([expandTabs("a\tfoo")], "foo").matches).toEqual([
      { line: 0, start: 4, end: 7 },
    ]);
  });

  it("stops at the cap and says more were left", () => {
    const result = findLineMatches(["x".repeat(FILE_FIND_MATCH_LIMIT + 5)], "x");
    expect(result.matches).toHaveLength(FILE_FIND_MATCH_LIMIT);
    expect(result.limited).toBe(true);
  });
});
