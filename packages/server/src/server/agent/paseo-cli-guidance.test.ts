import { expect, test } from "vitest";
import { getPaseoCliCommands } from "./paseo-cli-guidance.js";

test("advertises only CLI commands mapped from tools allowed by provider policy", () => {
  const commands = getPaseoCliCommands({
    disabledTools: ["create_agent", "list_agents", "browser_click"],
  });

  expect(commands).toContain("agent status");
  expect(commands).toContain("browser snapshot");
  expect(commands).not.toContain("agent run --no-wait");
  expect(commands).not.toContain("agent query");
  expect(commands).not.toContain("browser click");
});

test("does not advertise CLI commands when native tools are disabled for the provider", () => {
  expect(getPaseoCliCommands({ enabled: false })).toEqual([]);
});
