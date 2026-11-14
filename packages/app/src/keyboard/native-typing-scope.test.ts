import { expect, test } from "vitest";
import { claimNativeTypingScope, getNativeTypingScope } from "./native-typing-scope";

test("a released claim returns plain fields to the editable scope", () => {
  const release = claimNativeTypingScope("terminal");
  expect(getNativeTypingScope()).toBe("terminal");
  release();
  expect(getNativeTypingScope()).toBe("editable");
});

test("a stale release cannot drop a newer claim", () => {
  const releaseTerminal = claimNativeTypingScope("terminal");
  const releaseComposer = claimNativeTypingScope("message-input");
  releaseTerminal();
  expect(getNativeTypingScope()).toBe("message-input");
  releaseComposer();
  expect(getNativeTypingScope()).toBe("editable");
});
