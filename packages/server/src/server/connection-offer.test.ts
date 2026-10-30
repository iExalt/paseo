import { describe, expect, it } from "vitest";
import { joinAppBaseUrl } from "./connection-offer.js";

describe("joinAppBaseUrl", () => {
  it.each([
    ["https://app.paseo.sh", "https://app.paseo.sh/#offer=x"],
    ["https://app.paseo.sh/", "https://app.paseo.sh/#offer=x"],
    ["paseo://", "paseo:///#offer=x"],
    ["paseo:///", "paseo:///#offer=x"],
  ])("joins %s", (base, expected) => {
    expect(joinAppBaseUrl(base, "#offer=x")).toBe(expected);
  });
});
