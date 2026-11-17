import { resolveKeyboardFocusScope } from "../focus-scope";

export function hasFocusedTextInput(): boolean {
  if (typeof document === "undefined") return false;
  const scope = resolveKeyboardFocusScope({
    target: document.activeElement,
    commandCenterOpen: false,
  });
  return scope === "editable" || scope === "message-input" || scope === "terminal";
}
