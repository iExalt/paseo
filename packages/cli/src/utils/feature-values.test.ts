import { describe, expect, it } from "vitest";
import { parseFeatureValues } from "./feature-values.js";

describe("parseFeatureValues JSON values", () => {
  it("preserves arbitrary JSON values and combines them with primitive flags", () => {
    expect(
      parseFeatureValues(["enabled=false", 'label="true"'], '{"limits":[1,2],"config":{"x":true}}'),
    ).toEqual({
      limits: [1, 2],
      config: { x: true },
      enabled: false,
      label: "true",
    });
  });

  it("rejects duplicate keys across JSON and assignment forms", () => {
    expect(() => parseFeatureValues(["enabled=true"], '{"enabled":false}')).toThrow(
      "Feature specified more than once: enabled",
    );
  });

  it.each(["[]", "null", "true", "", "{broken}"])(
    "rejects non-object or malformed JSON value %j",
    (value) => {
      expect(() => parseFeatureValues([], value)).toThrow("Invalid --features-json value");
    },
  );
});
