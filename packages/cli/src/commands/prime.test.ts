import { describe, expect, it } from "vitest";
import { createPrimeCommand } from "./prime.js";

function primeText(): string {
  let text = "";
  const command = createPrimeCommand();
  command.configureOutput({ writeOut: (chunk) => (text += chunk) });
  command.parse([], { from: "user" });
  return text;
}

describe("prime", () => {
  it("teaches launchers to place workers explicitly and answer their questions", () => {
    const text = primeText();
    expect(text).toContain("--relationship detached");
    expect(text).toContain("workspace create --project <id> --no-background");
    expect(text).toContain("agent detach <id>");
    expect(text).toContain(
      'permit allow <agent> <req_id> --input \'{"answers":{"Question 1":"chosen label or free text"}}\'',
    );
    expect(text).toContain("Use every question's header as the key");
  });
});
