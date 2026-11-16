export interface FocusClaimState {
  claimedKey: string | null;
  requestedKey: string | null;
}

export interface FocusClaimStep {
  state: FocusClaimState;
  shouldRequest: boolean;
}

export interface FocusClaimReadiness {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isAppActivelyVisible: boolean;
  isClientReady: boolean;
  isConnected: boolean;
  isRendererReady: boolean;
}

interface TerminalSize {
  rows: number;
  cols: number;
}

export function resolveTerminalResizeClaim(input: {
  size: TerminalSize;
  previousSentSize: TerminalSize | null;
  shouldClaim: boolean;
  forceClaim: boolean;
  supportsTerminalSizeOwnership: boolean;
  readiness: FocusClaimReadiness;
}): { shouldSend: boolean; intent: "claim" | "update" } {
  const intent = input.shouldClaim ? "claim" : "update";
  if (intent === "claim") {
    if (!canRequestFocusClaim(input.readiness)) {
      return { shouldSend: false, intent };
    }
    if (input.supportsTerminalSizeOwnership) {
      return { shouldSend: true, intent };
    }
    return {
      shouldSend:
        input.forceClaim ||
        input.previousSentSize === null ||
        input.previousSentSize.rows !== input.size.rows ||
        input.previousSentSize.cols !== input.size.cols,
      intent,
    };
  }

  if (!input.supportsTerminalSizeOwnership || !canRequestOwnedSizeUpdate(input.readiness)) {
    return { shouldSend: false, intent };
  }

  return {
    shouldSend:
      input.previousSentSize === null ||
      input.previousSentSize.rows !== input.size.rows ||
      input.previousSentSize.cols !== input.size.cols,
    intent,
  };
}

function canRequestOwnedSizeUpdate(input: FocusClaimReadiness): boolean {
  return (
    input.isWorkspaceFocused &&
    input.isAppActivelyVisible &&
    input.isClientReady &&
    input.isConnected &&
    input.isRendererReady
  );
}

export const EMPTY_FOCUS_CLAIM_STATE: FocusClaimState = {
  claimedKey: null,
  requestedKey: null,
};

export function canRequestFocusClaim(input: FocusClaimReadiness): boolean {
  return (
    input.isWorkspaceFocused &&
    input.isPaneFocused &&
    input.isAppActivelyVisible &&
    input.isClientReady &&
    input.isConnected &&
    input.isRendererReady
  );
}

export function reconcileFocusClaim(
  state: FocusClaimState,
  input: { key: string | null; canRequest: boolean },
): FocusClaimStep {
  if (input.key === null) {
    return { state: EMPTY_FOCUS_CLAIM_STATE, shouldRequest: false };
  }
  if (state.claimedKey === input.key) {
    return {
      state: { claimedKey: input.key, requestedKey: null },
      shouldRequest: false,
    };
  }
  if (!input.canRequest) {
    return {
      state: { claimedKey: state.claimedKey, requestedKey: null },
      shouldRequest: false,
    };
  }
  if (state.requestedKey === input.key) {
    return { state, shouldRequest: false };
  }
  return {
    state: { claimedKey: state.claimedKey, requestedKey: input.key },
    shouldRequest: true,
  };
}

export function settleFocusClaim(
  state: FocusClaimState,
  input: { key: string; sent: boolean },
): FocusClaimState {
  if (state.requestedKey !== input.key) {
    return state;
  }
  return {
    claimedKey: input.sent ? input.key : state.claimedKey,
    requestedKey: null,
  };
}

/**
 * Android can leave a soft keyboard that was open elsewhere (the agent composer) attached to the
 * hidden terminal input when the terminal comes back on screen, without focusing that input. Keys
 * then miss the field: Samsung's Enter adds no line break, so the line is never cleared and
 * reappears in later edits. Focus the input once on return, while the keyboard is settled open,
 * as the keyboard toggle would.
 */
export function shouldReclaimTerminalKeyboard(input: {
  wasPresented: boolean;
  isPresented: boolean;
  isKeyboardVisible: boolean;
}): boolean {
  return input.isPresented && !input.wasPresented && input.isKeyboardVisible;
}
