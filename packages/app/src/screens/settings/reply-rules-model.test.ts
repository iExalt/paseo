import { describe, expect, it } from "vitest";
import {
  acknowledgeReplyRulesMutation,
  applyAuthoritativeReplyRules,
  beginReplyRulesMutation,
  createReplyRulesEditorState,
  editReplyRulesDraft,
  failReplyRulesMutation,
  isReplyRulesDraftDirty,
  resolveReplyRulesConflict,
} from "./reply-rules-model";

const firstRule = { source: "^No news\\.$", flags: "i" };
const secondRule = { source: "^Still waiting$", flags: "" };
const thirdRule = { source: "^Nothing to report$", flags: "m" };

describe("reply rules editor model", () => {
  it("loads authoritative rules and follows external updates while the draft is clean", () => {
    let state = createReplyRulesEditorState();
    state = applyAuthoritativeReplyRules(state, [firstRule]);
    expect(state.savedRules).toEqual([firstRule]);
    expect(state.draftRules).toEqual([firstRule]);

    state = applyAuthoritativeReplyRules(state, [secondRule]);
    expect(state.savedRules).toEqual([secondRule]);
    expect(state.draftRules).toEqual([secondRule]);
    expect(state.conflict).toBe(false);
  });

  it("keeps a dirty draft on external update until the user reloads or keeps it", () => {
    let state = applyAuthoritativeReplyRules(createReplyRulesEditorState(), [firstRule]);
    state = editReplyRulesDraft(state, [secondRule]);
    state = applyAuthoritativeReplyRules(state, []);

    expect(state.savedRules).toEqual([]);
    expect(state.draftRules).toEqual([secondRule]);
    expect(state.conflict).toBe(true);
    expect(isReplyRulesDraftDirty(state)).toBe(true);
    expect(editReplyRulesDraft(state, [])).toBe(state);

    const kept = resolveReplyRulesConflict(state, "keep");
    expect(kept.draftRules).toEqual([secondRule]);
    expect(kept.conflict).toBe(false);
    expect(isReplyRulesDraftDirty(kept)).toBe(true);
    expect(resolveReplyRulesConflict(state, "reload").draftRules).toEqual([]);
  });

  it("ignores an unrelated config event when the saved rules are unchanged", () => {
    let state = applyAuthoritativeReplyRules(createReplyRulesEditorState(), [firstRule]);
    state = editReplyRulesDraft(state, [secondRule]);
    state = {
      ...state,
      error: "A prior save failed",
      errorOperation: "write",
    };

    const updated = applyAuthoritativeReplyRules(state, [firstRule]);

    expect(updated).toBe(state);
    expect(updated.savedRules).toEqual([firstRule]);
    expect(updated.draftRules).toEqual([secondRule]);
    expect(updated.conflict).toBe(false);
    expect(updated.error).toBe("A prior save failed");
  });

  it("does not let a late mutation ACK overwrite a newer authoritative event", () => {
    let state = applyAuthoritativeReplyRules(createReplyRulesEditorState(), [firstRule]);
    state = editReplyRulesDraft(state, [secondRule]);
    state = beginReplyRulesMutation(state, "save", state.draftRules);
    state = applyAuthoritativeReplyRules(state, [thirdRule]);
    expect(state.savedRules).toEqual([thirdRule]);
    expect(state.draftRules).toEqual([secondRule]);
    expect(state.conflict).toBe(true);
    expect(state.pending).not.toBeNull();

    state = acknowledgeReplyRulesMutation(state);
    expect(state.savedRules).toEqual([thirdRule]);
    expect(state.draftRules).toEqual([secondRule]);
    expect(state.pending).toBeNull();
    expect(state.conflict).toBe(true);

    state = resolveReplyRulesConflict(state, "keep");
    state = applyAuthoritativeReplyRules(state, [secondRule]);
    expect(state.savedRules).toEqual([secondRule]);
    expect(state.draftRules).toEqual([secondRule]);
    expect(state.pending).toBeNull();
    expect(state.conflict).toBe(false);

    state = editReplyRulesDraft(state, [firstRule]);
    state = applyAuthoritativeReplyRules(state, []);
    expect(state.conflict).toBe(true);
    const lateAck = acknowledgeReplyRulesMutation(state);
    expect(lateAck.savedRules).toEqual([]);
    expect(lateAck.draftRules).toEqual([firstRule]);
  });

  it("retains saved rules and the draft when a save or clear fails", () => {
    const initial = applyAuthoritativeReplyRules(createReplyRulesEditorState(), [firstRule]);
    const draft = editReplyRulesDraft(initial, [secondRule]);
    const saving = beginReplyRulesMutation(draft, "save", draft.draftRules);
    const failedSave = failReplyRulesMutation(saving, "Invalid regular expression");
    expect(failedSave.savedRules).toEqual([firstRule]);
    expect(failedSave.draftRules).toEqual([secondRule]);
    expect(failedSave.error).toBe("Invalid regular expression");
    expect(failedSave.pending).toBeNull();

    const clearing = beginReplyRulesMutation(draft, "clear", []);
    const failedClear = failReplyRulesMutation(clearing, "Permission denied");
    expect(failedClear.savedRules).toEqual([firstRule]);
    expect(failedClear.draftRules).toEqual([secondRule]);
    expect(failedClear.pending).toBeNull();
  });

  it("waits for an authoritative empty list to settle clear and ignores unchanged saves", () => {
    const initial = applyAuthoritativeReplyRules(createReplyRulesEditorState(), [firstRule]);
    const draft = editReplyRulesDraft(initial, [secondRule]);
    let state = beginReplyRulesMutation(draft, "clear", []);
    expect(state.pending?.operation).toBe("clear");
    state = acknowledgeReplyRulesMutation(state);
    expect(state.pending).toBeNull();
    expect(state.savedRules).toEqual([firstRule]);
    state = applyAuthoritativeReplyRules(state, []);
    expect(state.savedRules).toEqual([]);
    expect(state.draftRules).toEqual([]);
    expect(state.pending).toBeNull();

    expect(beginReplyRulesMutation(state, "save", [])).toBe(state);
  });
});
