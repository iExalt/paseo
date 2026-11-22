import React, { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AdaptiveTextInput } from "./adaptive-text-input";
import { EditingTextInput } from "./ui/text-input";

interface MountedInput {
  root: Root;
  container: HTMLDivElement;
}

const mountedInputs: MountedInput[] = [];

function SchedulePromptHarness({ changes }: { changes: string[] }) {
  const [prompt, setPrompt] = useState("");
  const handleChangeText = useCallback(
    (text: string) => {
      changes.push(text);
      setPrompt(text);
    },
    [changes],
  );
  return (
    <AdaptiveTextInput
      initialValue={prompt}
      multiline
      onChangeText={handleChangeText}
      testID="schedule-prompt-input"
    />
  );
}

function mountSchedulePrompt(changes: string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<SchedulePromptHarness changes={changes} />));

  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Schedule prompt did not render a textarea");
  }

  const mounted = { root, container, textarea };
  mountedInputs.push(mounted);
  return mounted;
}

function typeFromIme(textarea: HTMLTextAreaElement, text: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("HTML textarea value setter is unavailable");
  }
  valueSetter.call(textarea, text);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
}

afterEach(() => {
  for (const mounted of mountedInputs.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("AdaptiveTextInput web IME composition", () => {
  it("keeps the candidate editing-surface owned until composition commits", () => {
    const changes: string[] = [];
    const { textarea } = mountSchedulePrompt(changes);

    act(() => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      typeFromIme(textarea, "n");
    });

    expect(textarea.value).toBe("n");
    expect(changes).toEqual([]);

    act(() => {
      textarea.value = "你";
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });

    expect(textarea.value).toBe("你");
    expect(changes).toEqual(["你"]);
  });
});

function mountSelectOnFocusInput(initialValue = "", autoFocus = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedInputs.push({ root, container });
  act(() =>
    root.render(
      <EditingTextInput initialValue={initialValue} selectTextOnFocus autoFocus={autoFocus} />,
    ),
  );
  const input = container.querySelector("input");
  if (!input) throw new Error("Expected a text input");
  return input;
}

function insertText(value: string) {
  expect(document.execCommand("insertText", false, value)).toBe(true);
}

function finishFocusTask() {
  // Run after the selection scheduled by focus.
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("EditingTextInput web select on focus", () => {
  it("selects the initial value on autofocus before the input ref attaches", async () => {
    const input = mountSelectOnFocusInput("original", true);
    expect(document.activeElement).toBe(input);
    await finishFocusTask();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "original".length]);
  });

  it("preserves the first edit in an empty field and selects existing text on refocus", async () => {
    const input = mountSelectOnFocusInput();
    // Keep focus and the first edit in the same browser task to exercise deferred select-all.
    act(() => {
      input.focus();
      insertText("1");
    });
    await finishFocusTask();
    act(() => insertText("0"));
    expect(input.value).toBe("10");

    act(() => {
      input.blur();
      input.focus();
    });
    await finishFocusTask();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
    act(() => insertText("2"));
    expect(input.value).toBe("2");
  });

  it("does not reselect edited text even if its value still matches the value at focus", async () => {
    const input = mountSelectOnFocusInput("7");
    act(() => {
      input.focus();
      input.setSelectionRange(0, 1);
      insertText("7");
    });
    await finishFocusTask();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    act(() => insertText("0"));
    expect(input.value).toBe("70");
  });
});
