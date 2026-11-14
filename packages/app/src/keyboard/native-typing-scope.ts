import type { NativeTypingScope } from "@/keyboard/native-shortcut-policy";

/**
 * Native reports only that a text input has focus. Inputs that web gives their
 * own focus scope (the composer, the native terminal) claim it here on focus so
 * native shortcuts resolve with the same scope web would use. Any other focused
 * input counts as `editable`.
 */
let current: { scope: NativeTypingScope; token: object } | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Claims the typing scope until the returned release runs or another input claims it. */
export function claimNativeTypingScope(scope: NativeTypingScope): () => void {
  const token = {};
  current = { scope, token };
  notify();
  return () => {
    if (current?.token !== token) return;
    current = null;
    notify();
  };
}

export function getNativeTypingScope(): NativeTypingScope {
  return current?.scope ?? "editable";
}

export function subscribeNativeTypingScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
