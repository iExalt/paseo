import { expect, test } from "vitest";
import { findOpMessages } from "./find-messages";

test("an action taken before the debounced query went out sends that query first", () => {
  expect(findOpMessages("replaceAll", "foo", "fo")).toEqual([
    { type: "findQuery", query: "foo" },
    { type: "find", op: "replaceAll" },
  ]);
  expect(findOpMessages("next", "foo", "foo")).toEqual([{ type: "find", op: "next" }]);
  expect(findOpMessages("close", "foo", "fo")).toEqual([{ type: "find", op: "close" }]);
});
