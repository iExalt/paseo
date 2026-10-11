import type { CommandError } from "../output/index.js";

export function parseFeatureValues(
  flags: string[] | undefined,
  featuresJson?: string,
): Record<string, unknown> {
  const jsonEntries = parseFeatureObject(featuresJson);
  if (!flags?.length) return jsonEntries;

  const entries = new Map<string, unknown>(Object.entries(jsonEntries));
  for (const flag of splitFeatureAssignments(flags)) {
    const equalsIndex = flag.indexOf("=");
    const featureId = equalsIndex === -1 ? "" : flag.slice(0, equalsIndex).trim();
    const rawValue = equalsIndex === -1 ? "" : flag.slice(equalsIndex + 1);
    if (!featureId || !rawValue.trim()) {
      throw {
        code: "INVALID_FEATURE",
        message: `Invalid feature format: ${flag}`,
        details: "Features must use a non-empty feature ID and value in id=value format.",
      } satisfies CommandError;
    }
    if (entries.has(featureId)) {
      throw {
        code: "INVALID_FEATURE",
        message: `Feature specified more than once: ${featureId}`,
        details: "Specify each feature ID once.",
      } satisfies CommandError;
    }

    entries.set(featureId, parseFeatureValue(rawValue, flag));
  }

  return Object.fromEntries(entries);
}

function parseFeatureObject(featuresJson: string | undefined): Record<string, unknown> {
  if (featuresJson === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(featuresJson);
  } catch {
    throw {
      code: "INVALID_FEATURE",
      message: "Invalid --features-json value",
      details: "Provide a JSON object mapping feature IDs to values.",
    } satisfies CommandError;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw {
      code: "INVALID_FEATURE",
      message: "Invalid --features-json value",
      details: "Provide a JSON object mapping feature IDs to values.",
    } satisfies CommandError;
  }
  return Object.fromEntries(Object.entries(parsed));
}

function parseFeatureValue(rawValue: string, flag: string): unknown {
  if (rawValue.trimStart().startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      throw invalidFeatureValue(flag);
    }
    if (typeof parsed !== "string" || parsed.length === 0) {
      throw invalidFeatureValue(flag);
    }
    return parsed;
  }

  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  return rawValue;
}

function splitFeatureAssignments(flags: string[]): string[] {
  const assignments: string[] = [];
  for (const flag of flags) {
    let start = 0;
    let inQuotedString = false;
    let escaped = false;
    for (let index = 0; index < flag.length; index += 1) {
      const character = flag[index];
      if (inQuotedString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inQuotedString = false;
        }
      } else if (character === '"') {
        inQuotedString = true;
      } else if (character === ",") {
        assignments.push(flag.slice(start, index).trim());
        start = index + 1;
      }
    }
    if (inQuotedString || escaped) {
      throw invalidFeatureValue(flag);
    }
    assignments.push(flag.slice(start).trim());
  }
  return assignments;
}

function invalidFeatureValue(flag: string): CommandError {
  return {
    code: "INVALID_FEATURE",
    message: `Invalid feature value: ${flag}`,
    details: "Use true, false, null, a non-empty string, or a quoted JSON string.",
  };
}
