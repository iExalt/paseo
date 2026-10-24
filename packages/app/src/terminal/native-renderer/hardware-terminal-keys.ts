import { parseNativeTerminalKeyEvent, type NativeTerminalKeyEvent } from "./terminal-key-events";

export interface HardwareTerminalKeySource {
  addListener(handler: (payload: unknown) => void): { remove: () => void };
}

export interface HardwareTerminalKeyRouter {
  /**
   * Sends captured hardware terminal keys to `handler` until the returned
   * release runs or another terminal input claims them.
   */
  claim(handler: (event: NativeTerminalKeyEvent) => void): () => void;
}

/**
 * Native captures a hardware terminal key only while a native terminal input
 * holds focus, so it reports keys without saying which terminal. The input
 * that most recently gained focus owns them.
 */
export function createHardwareTerminalKeyRouter(
  source: HardwareTerminalKeySource,
): HardwareTerminalKeyRouter {
  let owner: { handler: (event: NativeTerminalKeyEvent) => void; token: object } | null = null;
  let subscription: { remove: () => void } | null = null;

  return {
    claim(handler) {
      const token = {};
      owner = { handler, token };
      subscription ??= source.addListener((payload) => {
        const event = parseNativeTerminalKeyEvent(payload);
        if (event) owner?.handler(event);
      });
      return () => {
        if (owner?.token !== token) return;
        owner = null;
        subscription?.remove();
        subscription = null;
      };
    },
  };
}
