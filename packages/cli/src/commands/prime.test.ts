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
  it("teaches launchers to place workers explicitly", () => {
    const text = primeText();
    expect(text).toContain("--relationship detached");
    expect(text).toContain("workspace create --project <id> --no-background");
    expect(text).toContain("agent detach <id>");
  });
});
