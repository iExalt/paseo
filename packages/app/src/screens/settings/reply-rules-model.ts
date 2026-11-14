import type { ReplyRule } from "@getpaseo/protocol/messages";

export type ReplyRulesOperation = "save" | "clear";

export interface ReplyRulesEditorState {
  savedRules: ReplyRule[] | null;
  draftRules: ReplyRule[];
  draftRevision: number;
  pending: { operation: ReplyRulesOperation; rules: ReplyRule[] } | null;
  awaitingAuthorityRules: ReplyRule[] | null;
  conflict: boolean;
  error: string | null;
  errorOperation: "read" | "write" | null;
}

export type ReplyRulesEditorAction =
  | { type: "authoritative"; rules: readonly ReplyRule[] }
  | { type: "edit"; rules: readonly ReplyRule[] }
  | { type: "resolve-conflict"; resolution: "reload" | "keep" }
  | { type: "begin-mutation"; operation: ReplyRulesOperation; rules: readonly ReplyRule[] }
  | { type: "acknowledge-mutation" }
  | { type: "fail-mutation"; error: string }
  | { type: "fail-load"; error: string };

export function createReplyRulesEditorState(): ReplyRulesEditorState {
  return {
    savedRules: null,
    draftRules: [],
    draftRevision: 0,
    pending: null,
    awaitingAuthorityRules: null,
    conflict: false,
    error: null,
    errorOperation: null,
  };
}

export function areReplyRulesEqual(
  left: readonly ReplyRule[],
  right: readonly ReplyRule[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (rule, index) => rule.source === right[index]?.source && rule.flags === right[index]?.flags,
    )
  );
}

export function isReplyRulesDraftDirty(state: ReplyRulesEditorState): boolean {
  return state.savedRules !== null && !areReplyRulesEqual(state.savedRules, state.draftRules);
}

export function applyAuthoritativeReplyRules(
  state: ReplyRulesEditorState,
  rules: readonly ReplyRule[],
): ReplyRulesEditorState {
  const savedRules = rules.map((rule) => ({ ...rule }));
  const matchesPending =
    state.pending !== null && areReplyRulesEqual(state.pending.rules, savedRules);
  const matchesAcknowledged =
    state.awaitingAuthorityRules !== null &&
    areReplyRulesEqual(state.awaitingAuthorityRules, savedRules);
  const matchesMutation = matchesPending || matchesAcknowledged;
  if (
    !matchesMutation &&
    state.savedRules !== null &&
    areReplyRulesEqual(state.savedRules, savedRules)
  ) {
    return state;
  }
  const replacesDraft =
    matchesMutation || state.savedRules === null || !isReplyRulesDraftDirty(state);
  const draftRules = replacesDraft ? savedRules.map((rule) => ({ ...rule })) : state.draftRules;
  const conflict = !matchesMutation && !areReplyRulesEqual(draftRules, savedRules);
  const pending = state.pending;

  return {
    ...state,
    savedRules,
    draftRules,
    draftRevision: state.draftRevision + (replacesDraft ? 1 : 0),
    pending,
    awaitingAuthorityRules:
      matchesAcknowledged || !matchesPending ? null : state.awaitingAuthorityRules,
    conflict,
    error: null,
    errorOperation: null,
  };
}

export function editReplyRulesDraft(
  state: ReplyRulesEditorState,
  draftRules: readonly ReplyRule[],
): ReplyRulesEditorState {
  if (
    state.savedRules === null ||
    state.pending ||
    state.awaitingAuthorityRules ||
    state.conflict
  ) {
    return state;
  }
  const nextDraft = draftRules.map((rule) => ({ ...rule }));
  return {
    ...state,
    draftRules: nextDraft,
    error: null,
    errorOperation: null,
  };
}

export function resolveReplyRulesConflict(
  state: ReplyRulesEditorState,
  resolution: "reload" | "keep",
): ReplyRulesEditorState {
  if (state.savedRules === null || state.pending || !state.conflict) return state;
  return {
    ...state,
    draftRules:
      resolution === "reload" ? state.savedRules.map((rule) => ({ ...rule })) : state.draftRules,
    draftRevision: state.draftRevision + (resolution === "reload" ? 1 : 0),
    awaitingAuthorityRules: null,
    conflict: false,
    error: null,
    errorOperation: null,
  };
}

export function beginReplyRulesMutation(
  state: ReplyRulesEditorState,
  operation: ReplyRulesOperation,
  rules: readonly ReplyRule[],
): ReplyRulesEditorState {
  if (
    state.savedRules === null ||
    state.pending ||
    state.awaitingAuthorityRules ||
    state.conflict ||
    (operation === "save"
      ? areReplyRulesEqual(state.savedRules, rules)
      : state.savedRules.length === 0 && state.draftRules.length === 0)
  ) {
    return state;
  }
  return {
    ...state,
    pending: {
      operation,
      rules: rules.map((rule) => ({ ...rule })),
    },
    error: null,
    errorOperation: null,
  };
}

export function acknowledgeReplyRulesMutation(state: ReplyRulesEditorState): ReplyRulesEditorState {
  if (!state.pending) return state;
  if (state.savedRules && areReplyRulesEqual(state.savedRules, state.pending.rules)) {
    return {
      ...state,
      draftRules: state.savedRules,
      draftRevision: state.draftRevision + 1,
      pending: null,
      awaitingAuthorityRules: null,
      conflict: false,
      error: null,
      errorOperation: null,
    };
  }
  return {
    ...state,
    pending: null,
    awaitingAuthorityRules: state.conflict
      ? null
      : state.pending.rules.map((rule) => ({ ...rule })),
    error: null,
    errorOperation: null,
  };
}

export function failReplyRulesMutation(
  state: ReplyRulesEditorState,
  error: string,
): ReplyRulesEditorState {
  return {
    ...state,
    pending: null,
    awaitingAuthorityRules: null,
    error,
    errorOperation: "write",
  };
}

export function failReplyRulesLoad(
  state: ReplyRulesEditorState,
  error: string,
): ReplyRulesEditorState {
  return { ...state, error, errorOperation: "read" };
}

export function reduceReplyRulesEditorState(
  state: ReplyRulesEditorState,
  action: ReplyRulesEditorAction,
): ReplyRulesEditorState {
  switch (action.type) {
    case "authoritative":
      return applyAuthoritativeReplyRules(state, action.rules);
    case "edit":
      return editReplyRulesDraft(state, action.rules);
    case "resolve-conflict":
      return resolveReplyRulesConflict(state, action.resolution);
    case "begin-mutation":
      return beginReplyRulesMutation(state, action.operation, action.rules);
    case "acknowledge-mutation":
      return acknowledgeReplyRulesMutation(state);
    case "fail-mutation":
      return failReplyRulesMutation(state, action.error);
    case "fail-load":
      return failReplyRulesLoad(state, action.error);
  }
}
