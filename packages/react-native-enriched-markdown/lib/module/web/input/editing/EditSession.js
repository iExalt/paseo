"use strict";

// The phase lets handlers tell a user action from an echo of our own writes.
//
// The authority on composition is the event (`InputEvent.isComposing`,
// `KeyboardEvent.isComposing`); this latch only covers handlers that get no
// event to ask, so it has to be cleared on every way out of a composition
// (commit, blur, teardown) or the editor would stay read-only for good.
export class EditSession {
  composing = false;
  currentPhase = 'idle';
  get phase() {
    return this.currentPhase;
  }
  get isComposing() {
    return this.composing;
  }
  beginComposition() {
    this.composing = true;
  }
  endComposition() {
    this.composing = false;
  }
  scoped(phase, block) {
    const previous = this.currentPhase;
    this.currentPhase = phase;
    try {
      return block();
    } finally {
      this.currentPhase = previous;
    }
  }
  get shouldSuppressEvents() {
    return this.currentPhase === 'importing';
  }

  // Only catches a side effect delivered on the same stack as the write that
  // caused it. `selectionchange` is queued rather than dispatched, so this
  // does not cover it - see `InputHost.handleSelectionChange`.
  get shouldSuppressSelectionSideEffects() {
    return this.currentPhase !== 'idle';
  }
}
//# sourceMappingURL=EditSession.js.map
