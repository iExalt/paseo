import { expect, test } from "vitest";
import { findActionsEnabled, findOpMessages } from "./find-messages";

test("an action taken before the debounced query went out sends that query first", () => {
  expect(findOpMessages("replaceAll", "foo", "fo")).toEqual([
    { type: "findQuery", query: "foo" },
    { type: "find", op: "replaceAll" },
  ]);
  expect(findOpMessages("next", "foo", "foo")).toEqual([{ type: "find", op: "next" }]);
  expect(findOpMessages("close", "foo", "fo")).toEqual([{ type: "find", op: "close" }]);
});

test("actions stay enabled for a query the page has not searched yet", () => {
  expect(findActionsEnabled({ query: "", total: 0 }, "item 7")).toBe(true);
  expect(findActionsEnabled({ query: "item 7", total: 0 }, "item 7")).toBe(false);
  expect(findActionsEnabled({ query: "item 7", total: 2 }, "item 7")).toBe(true);
  expect(findActionsEnabled({ query: "x", total: 0 }, "")).toBe(false);
});
