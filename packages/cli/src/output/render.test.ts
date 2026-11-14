import { expect, it } from "vitest";
import { renderError, toCommandError } from "./index.js";

it("preserves the message of an Error with an RPC code in JSON output", () => {
  const error = Object.assign(new Error("Plugin requires Paseo >=0.8.0. Your daemon is 0.7.2."), {
    code: "handler_error",
    requestId: "request-1",
  });
  expect(JSON.parse(renderError(toCommandError(error), { format: "json" }))).toEqual({
    error: {
      code: "handler_error",
      requestId: "request-1",
      message: "Plugin requires Paseo >=0.8.0. Your daemon is 0.7.2.",
    },
  });
});

it("renders ordinary errors once without a JavaScript stack", () => {
  const error = toCommandError(new Error("Agent not found: missing"));
  expect(error).toEqual({ code: "UNKNOWN_ERROR", message: "Agent not found: missing" });
  expect(renderError(error, { noColor: true })).toBe("Error: Agent not found: missing");
});

it("preserves intentional structured details", () => {
  const error = {
    code: "AGENT_NOT_FOUND",
    message: "Unknown agent",
    details: { host: "selected" },
  };
  expect(JSON.parse(renderError(toCommandError(error), { format: "json" }))).toEqual({ error });
});

it("extracts plain object messages without printing object Object", () => {
  expect(toCommandError({ message: "Access denied" })).toEqual({
    code: "UNKNOWN_ERROR",
    message: "Access denied",
  });
  expect(toCommandError({ reason: "Access denied" })).toEqual({
    code: "UNKNOWN_ERROR",
    message: "{ reason: 'Access denied' }",
  });
});
