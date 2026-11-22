import { describe, expect, it } from "vitest";
import { mergeProfileControls, withProfileDefaults } from "./agent-profile.js";

const reasoning = "cursor_model_reasoning_effort";
const fast = "cursor_model_fast";
const profile = {
  id: "cursor",
  name: "Cursor",
  provider: "cursor-sdk",
  model: "composer",
  thinkingOptionId: "none",
  featureValues: { [fast]: "false", [reasoning]: "none" },
};

describe("Cursor SDK profile controls", () => {
  it("uses explicit thinking or clear-thinking over inherited reasoning", () => {
    const run = withProfileDefaults({ thinking: "high" }, profile);
    expect(run).toMatchObject({
      thinking: "high",
      featuresJson: JSON.stringify({ [fast]: "false" }),
    });
    expect(mergeProfileControls(profile, null, {})).toEqual({
      thinkingOptionId: null,
      featureValues: { [fast]: "false" },
    });
  });

  it("uses an explicit reasoning feature over inherited thinking, including JSON resets", () => {
    expect(withProfileDefaults({ feature: [`${reasoning}=high`] }, profile)).toMatchObject({
      thinking: undefined,
      featuresJson: JSON.stringify({ [fast]: "false", [reasoning]: "high" }),
    });
    expect(mergeProfileControls(profile, undefined, { [reasoning]: null })).toEqual({
      thinkingOptionId: undefined,
      featureValues: { [fast]: "false", [reasoning]: null },
    });
  });
});
