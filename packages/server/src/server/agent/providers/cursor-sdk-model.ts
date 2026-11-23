import type { ModelSelection, SDKModel } from "@cursor/sdk";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { AgentOptionControl, AgentOptionSelectControl } from "../agent-sdk-types.js";
import type { ProviderOptionsPatch } from "../option-controls.js";

const DEFAULT_MODEL = "auto";
const PARAMETER_PREFIX = "cursor_model_";
const CONTEXT_OPTION_KEY = PARAMETER_PREFIX + "context";

/**
 * Verified fixed context-window sizes for Cursor SDK models whose `/v1/models`
 * entry omits a `context` parameter. Models with dynamic routing (`auto`,
 * `default`, `auto-smart`) or unverified Cursor-enforced caps stay omitted.
 */
const CURSOR_MODEL_CONTEXT_WINDOW_FALLBACKS: Readonly<Record<string, number>> = {
  "claude-opus-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "gpt-5.3-codex": 272_000,
};

export function parseCursorContextWindowParam(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
  const tokens = Math.round(amount * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export function resolveCursorContextWindowMaxTokens(
  model: Pick<SDKModel, "id" | "parameters" | "variants">,
  options: ProviderOptions = {},
): number | undefined {
  const fromOption = parseCursorContextWindowParam(options[CONTEXT_OPTION_KEY]);
  if (fromOption !== undefined) return fromOption;

  const defaultParam = model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((param) => param.id === "context")?.value;
  const fromDefaultVariant = parseCursorContextWindowParam(defaultParam);
  if (fromDefaultVariant !== undefined) return fromDefaultVariant;

  const contextParameter = model.parameters?.find((parameter) => parameter.id === "context");
  if (contextParameter?.values.length === 1) {
    const sole = parseCursorContextWindowParam(contextParameter.values[0]?.value);
    if (sole !== undefined) return sole;
  }

  return CURSOR_MODEL_CONTEXT_WINDOW_FALLBACKS[model.id.trim().toLowerCase()];
}

export function findCursorModel(models: SDKModel[], id: string): SDKModel | undefined {
  return (
    models.find((model) => model.id === id) ?? models.find((model) => model.aliases?.includes(id))
  );
}

export function defaultCursorModel(models: SDKModel[]): SDKModel | undefined {
  const auto = findCursorModel(models, DEFAULT_MODEL);
  if (auto && cursorSdkModelId(models, auto)) return auto;
  return models.find((model) => cursorSdkModelId(models, model));
}

export function resolveCursorModel(models: SDKModel[], requested?: string | null): SDKModel {
  const id = requested?.trim();
  const requestedModel = id ? findCursorModel(models, id) : undefined;
  const model =
    requestedModel ?? (!id || id === "default" ? defaultCursorModel(models) : undefined);
  if (!model) {
    throw new Error(
      id
        ? `Cursor SDK model "${id}" is unavailable. List Cursor SDK models for this account.`
        : "Cursor SDK reported no available models for this account.",
    );
  }
  return model;
}

/** The pinned SDK selects the first matching catalog row, including aliases. */
export function cursorSdkModelId(models: SDKModel[], model: SDKModel): string | undefined {
  return [model.id, ...(model.aliases ?? [])].find(
    (id) =>
      models.find((candidate) => candidate.id === id || candidate.aliases?.includes(id)) === model,
  );
}

export function cursorModelLabel(models: SDKModel[], model: SDKModel): string {
  return models.some((other) => other.id !== model.id && other.displayName === model.displayName)
    ? `${model.displayName} (${model.id})`
    : model.displayName;
}

export function cursorCatalogOptionKeys(models: SDKModel[]): Set<string> {
  return new Set(
    models.flatMap((model) => (model.parameters ?? []).map(({ id }) => PARAMETER_PREFIX + id)),
  );
}

export function cursorParameterControls(model: SDKModel): AgentOptionSelectControl[] {
  const defaults = model.variants?.find((variant) => variant.isDefault)?.params;
  return (model.parameters ?? []).map((parameter) => {
    const defaultValue = defaults?.find((entry) => entry.id === parameter.id)?.value;
    return {
      type: "select",
      key: PARAMETER_PREFIX + parameter.id,
      label: parameter.displayName ?? parameter.id,
      defaultValue: parameter.values.some((choice) => choice.value === defaultValue)
        ? defaultValue
        : undefined,
      choices: parameter.values.map((choice) => ({
        value: choice.value,
        label: choice.displayName ?? choice.value,
      })),
    };
  });
}

export function cursorReasoningControl(
  controls: AgentOptionSelectControl[],
): AgentOptionSelectControl | undefined {
  return (
    controls.find((entry) => entry.key === PARAMETER_PREFIX + "reasoning_effort") ??
    controls.find((entry) => entry.key === PARAMETER_PREFIX + "reasoning")
  );
}

function validateCursorOptions(
  modelId: string,
  controls: AgentOptionSelectControl[],
  requested: ProviderOptions,
  strict: boolean,
): ProviderOptions {
  const options: ProviderOptions = {};
  for (const [key, value] of Object.entries(requested)) {
    const control = controls.find((entry) => entry.key === key);
    if (control && value == null) continue;
    const choice = typeof value === "boolean" ? String(value) : value;
    if (control?.choices.some((entry) => entry.value === choice)) {
      options[key] = choice;
    } else if (strict) {
      throw new Error(`Unsupported Cursor SDK model option "${key}" for "${modelId}".`);
    }
  }
  return options;
}

export function resolveCursorOptions(
  model: SDKModel,
  controls: AgentOptionSelectControl[],
  requested: ProviderOptions,
  strict: boolean,
  previous: ProviderOptions = {},
): ProviderOptions {
  const options = validateCursorOptions(model.id, controls, requested, strict);
  const variants = model.variants ?? [];
  const requestedParams = selectCursorModel(model.id, options).params ?? [];
  const matches = (variant: (typeof variants)[number], param: (typeof requestedParams)[number]) =>
    variant.params.some((entry) => entry.id === param.id && entry.value === param.value);

  // Some catalog entries list only their default variant. A standalone parameter choice is
  // still valid when the variant list does not describe that choice.
  const knownParams = requestedParams.filter((param) =>
    variants.some((variant) => matches(variant, param)),
  );
  let compatible = variants.filter((variant) =>
    knownParams.every((param) => matches(variant, param)),
  );
  if (variants.length && !compatible.length) {
    if (strict) {
      throw new Error(`Unsupported Cursor SDK model option combination for "${model.id}".`);
    }
    return resolveCursorOptions(model, controls, {}, false);
  }

  // A newly selected control constrains its variant. Earlier values only break ties.
  for (const { key } of controls) {
    if (Object.hasOwn(requested, key) || typeof previous[key] !== "string") continue;
    const param = { id: key.slice(PARAMETER_PREFIX.length), value: previous[key] };
    const matching = compatible.filter((variant) => matches(variant, param));
    if (matching.length) compatible = matching;
    else if (variants.some((variant) => matches(variant, param))) continue;
    options[key] = param.value;
  }

  const preferred = compatible.find((variant) => variant.isDefault);
  if (preferred) compatible = [preferred];
  for (const param of compatible[0]?.params ?? []) {
    const key = PARAMETER_PREFIX + param.id;
    const control = controls.find((entry) => entry.key === key);
    if (
      options[key] == null &&
      control?.choices.some((choice) => choice.value === param.value) &&
      compatible.every((variant) => matches(variant, param))
    ) {
      options[key] = param.value;
    }
  }
  return options;
}

export function optionsForCursorControls(
  options: ProviderOptions,
  controls: AgentOptionControl[] | undefined,
): ProviderOptions {
  if (!controls) return options;
  return Object.fromEntries(
    Object.entries(options).filter(
      ([key, value]) =>
        typeof value === "string" &&
        controls.some(
          (control) =>
            control.key === key &&
            control.type === "select" &&
            control.choices.some((choice) => choice.value === value),
        ),
    ),
  );
}

export function cursorOptionsPatch(
  requested: ProviderOptions,
  effective: ProviderOptions,
): ProviderOptionsPatch {
  const keys = new Set([...Object.keys(requested), ...Object.keys(effective)]);
  return Object.fromEntries(
    Array.from(keys).flatMap((key) =>
      requested[key] === effective[key] ? [] : [[key, effective[key] ?? null]],
    ),
  );
}

export function selectCursorModel(id: string, options: ProviderOptions): ModelSelection {
  const params = Object.entries(options).flatMap(([key, value]) =>
    typeof value === "string" ? [{ id: key.slice(PARAMETER_PREFIX.length), value }] : [],
  );
  return params.length ? { id, params } : { id };
}
