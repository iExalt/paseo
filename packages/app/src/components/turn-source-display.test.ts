import { expect, test } from "vitest";
import { TURN_SOURCE_DISPLAY_LIMIT, turnSourceDisplay } from "./turn-source-display";

test("a turn shows its Markdown source whole up to the display limit, then its start", () => {
  expect(turnSourceDisplay("# Title\n- item")).toEqual({
    text: "# Title\n- item",
    truncated: false,
  });
  const long = "x".repeat(TURN_SOURCE_DISPLAY_LIMIT + 5);
  expect(turnSourceDisplay(long)).toEqual({
    text: long.slice(0, TURN_SOURCE_DISPLAY_LIMIT),
    truncated: true,
  });
});
