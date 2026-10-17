import { expect, test } from "vitest";
import { HEALTHY_RENDERER, nextRendererHealth, type RendererHealth } from "./renderer-health";

function replay(events: Array<"ready" | "failure">): RendererHealth {
  return events.reduce(nextRendererHealth, HEALTHY_RENDERER);
}

test("renderers killed and recovered any number of times keep the editor", () => {
  expect(replay(["ready", "failure", "ready", "failure", "ready", "failure", "ready"])).toEqual(
    HEALTHY_RENDERER,
  );
});

test("three failures with no ready editor between them leave the file read-only for good", () => {
  expect(replay(["ready", "failure", "failure", "failure"]).unavailable).toBe(true);
  expect(replay(["failure", "failure", "failure", "ready"]).unavailable).toBe(true);
});
