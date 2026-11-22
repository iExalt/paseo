import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
  cursorModelLabel,
  cursorOptionsPatch,
  cursorParameterControls,
  cursorSdkModelId,
  defaultCursorModel,
  optionsForCursorControls,
  resolveCursorModel,
  resolveCursorOptions,
} from "./cursor-sdk-model.js";

const fast = "cursor_model_fast";
const reasoning = "cursor_model_reasoning_effort";
const model: SDKModel = {
  id: "flagship",
  displayName: "Flagship",
  parameters: [
    { id: "fast", values: [{ value: "true" }, { value: "false" }] },
    { id: "reasoning_effort", values: [{ value: "none" }, { value: "high" }, { value: "low" }] },
  ],
  variants: [
    {
      displayName: "Fast",
      isDefault: true,
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning_effort", value: "none" },
      ],
    },
    {
      displayName: "High",
      params: [
        { id: "fast", value: "false" },
        { id: "reasoning_effort", value: "high" },
      ],
    },
  ],
};

describe("Cursor SDK catalog selection", () => {
  it("resolves Auto without conflating canonical IDs, aliases, or duplicate labels", () => {
    const smart = { id: "auto-smart", displayName: "Auto", aliases: ["default"] };
    const automatic = { id: "default", displayName: "Auto", aliases: ["auto"] };
    const models = [smart, automatic];
    expect(defaultCursorModel(models)).toBe(automatic);
    expect(resolveCursorModel(models, "default")).toBe(automatic);
    expect(cursorSdkModelId(models, automatic)).toBe("auto");
    const shadowed = { id: "default", displayName: "Shadowed" };
    expect(cursorSdkModelId([smart, shadowed], shadowed)).toBeUndefined();
    expect(resolveCursorModel(models, "auto")).toBe(automatic);
    expect(resolveCursorModel(models, "auto-smart")).toBe(smart);
    expect(cursorModelLabel(models, smart)).toBe("Auto (auto-smart)");
    expect(cursorModelLabel(models, automatic)).toBe("Auto (default)");
    expect(() => resolveCursorModel(models, "missing")).toThrow("unavailable");
    expect(resolveCursorModel([model], "default")).toBe(model);
  });

  it("normalizes Fast and takes compatible previous values only as preferences", () => {
    const controls = cursorParameterControls(model);
    const defaults = resolveCursorOptions(model, controls, {}, true);
    expect(defaults).toEqual({ [fast]: "true", [reasoning]: "none" });
    const slow = resolveCursorOptions(model, controls, { [fast]: false }, true, defaults);
    expect(slow).toEqual({ [fast]: "false", [reasoning]: "high" });
    expect(cursorOptionsPatch({ ...defaults, [fast]: false }, slow)).toEqual(slow);
    expect(resolveCursorOptions(model, controls, { [fast]: true }, true, slow)).toEqual(defaults);
    expect(() =>
      resolveCursorOptions(model, controls, { [fast]: false, [reasoning]: "none" }, true, defaults),
    ).toThrow("option combination");
  });

  it("rejects new unsupported settings and tolerates previously stored settings", () => {
    const controls = cursorParameterControls(model);
    expect(() => resolveCursorOptions(model, controls, { unavailable: null }, true)).toThrow(
      "Unsupported Cursor SDK model option",
    );
    const persisted = { unavailable: true, [fast]: 1, [reasoning]: "low" };
    const options = resolveCursorOptions(model, controls, persisted, false);
    expect(options).toEqual({ [fast]: "true", [reasoning]: "low" });
    expect(cursorOptionsPatch(persisted, options)).toEqual({ unavailable: null, [fast]: "true" });
    expect(
      optionsForCursorControls({ [fast]: true, [reasoning]: "unsupported" }, controls),
    ).toEqual({});
    expect(optionsForCursorControls(options, controls)).toEqual(options);
  });
});
