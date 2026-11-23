import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
  cursorModelLabel,
  cursorOptionsPatch,
  cursorParameterControls,
  cursorSdkModelId,
  defaultCursorModel,
  optionsForCursorControls,
  parseCursorContextWindowParam,
  resolveCursorContextWindowMaxTokens,
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

describe("Cursor SDK context window resolution", () => {
  it("parses shorthand context window parameter values", () => {
    expect(parseCursorContextWindowParam("200k")).toBe(200_000);
    expect(parseCursorContextWindowParam("256k")).toBe(256_000);
    expect(parseCursorContextWindowParam("272k")).toBe(272_000);
    expect(parseCursorContextWindowParam("300K")).toBe(300_000);
    expect(parseCursorContextWindowParam("1m")).toBe(1_000_000);
    expect(parseCursorContextWindowParam("1.5M")).toBe(1_500_000);
    expect(parseCursorContextWindowParam("0k")).toBeUndefined();
    expect(parseCursorContextWindowParam("auto")).toBeUndefined();
    expect(parseCursorContextWindowParam(undefined)).toBeUndefined();
  });

  it("prefers explicit context option, then default variant, then verified fallback, leaving auto unset", () => {
    const parameterized: SDKModel = {
      id: "gemini-4-neon",
      displayName: "Gemini 4 Neon",
      parameters: [{ id: "context", values: [{ value: "300k" }, { value: "1m" }] }],
      variants: [
        { displayName: "300K", params: [{ id: "context", value: "300k" }] },
        { displayName: "1M", isDefault: true, params: [{ id: "context", value: "1m" }] },
      ],
    };
    expect(resolveCursorContextWindowMaxTokens(parameterized, {})).toBe(1_000_000);
    expect(
      resolveCursorContextWindowMaxTokens(parameterized, { cursor_model_context: "300k" }),
    ).toBe(300_000);
    expect(
      resolveCursorContextWindowMaxTokens({
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        parameters: [{ id: "context", values: [{ value: "200k" }] }],
      }),
    ).toBe(200_000);
    expect(
      resolveCursorContextWindowMaxTokens({
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
      }),
    ).toBe(200_000);
    expect(
      resolveCursorContextWindowMaxTokens({
        id: "gpt-5.3-codex",
        displayName: "Codex 5.3",
      }),
    ).toBe(272_000);
    expect(
      resolveCursorContextWindowMaxTokens({ id: "auto-smart", displayName: "Auto" }),
    ).toBeUndefined();
    expect(
      resolveCursorContextWindowMaxTokens({ id: "default", displayName: "Auto" }),
    ).toBeUndefined();
    expect(
      resolveCursorContextWindowMaxTokens({ id: "unknown-model", displayName: "Unknown" }),
    ).toBeUndefined();
  });
});
