"use strict";

import { classNameFor, isReusableRun } from "../render/DomRenderer.js";
import { isCaret } from "./SelectionMapper.js";

// An edit the browser performs itself, inside one run's text node.
//
// Every other edit is cancelled and rendered from the model, which then has
// to restore the caret by script - most of a keystroke's cost on a long
// document. For plain typing and single deletes inside a run the browser's
// own edit already is the DOM the model would render, and keeps spellcheck
// markers.
//
// `nodeText` predicts the text node after the edit; it is checked against
// the model's runs before the event is let through, and against the DOM on
// `input`.

// The edit `event` would make, if it stays inside one canonical run's text
// node; null otherwise.
export function planNativeEdit(event, context) {
  switch (event.inputType) {
    case 'insertText':
      return planInsert(event, context);
    case 'deleteContentBackward':
    case 'deleteContentForward':
      return planDelete(event, context);
    default:
      return null;
  }
}
function planInsert(event, context) {
  const data = event.data;
  // A newline is a structural edit, and the data transfer form is Safari's
  // and rare enough to leave to the model.
  if (data === null || data.length === 0 || /[\r\n]/.test(data)) {
    return null;
  }
  const selection = context.root.ownerDocument.getSelection();
  if (selection === null || !isCaret(selection)) {
    return null;
  }
  // A correction that addresses its own range replaces text elsewhere.
  const target = firstTargetRange(event);
  if (target !== null && !target.collapsed) {
    return null;
  }
  const node = selection.anchorNode;
  const located = node === null ? null : locateRun(node, context);
  if (located === null) {
    return null;
  }
  const offset = selection.anchorOffset;
  const editStart = context.modelOffsetFromDom(located.node, offset);
  if (editStart === null) {
    return null;
  }
  const current = located.node.data;
  return {
    editStart,
    deletedText: '',
    insertedText: data,
    ...located,
    nodeText: current.slice(0, offset) + data + current.slice(offset)
  };
}

// Needs a target range: taking the browser's edit means taking its idea of
// what one Backspace removes.
function planDelete(event, context) {
  const selection = context.root.ownerDocument.getSelection();
  const target = firstTargetRange(event);
  if (selection === null || !isCaret(selection) || target === null || target.collapsed || target.startContainer !== target.endContainer) {
    return null;
  }
  const located = locateRun(target.startContainer, context);
  if (located === null) {
    return null;
  }
  const {
    startOffset,
    endOffset
  } = target;
  const editStart = context.modelOffsetFromDom(located.node, startOffset);
  if (editStart === null) {
    return null;
  }
  const current = located.node.data;
  return {
    editStart,
    deletedText: current.slice(startOffset, endOffset),
    insertedText: '',
    ...located,
    nodeText: current.slice(0, startOffset) + current.slice(endOffset)
  };
}

// The text node's run span and line, when both are the renderer's own.
function locateRun(node, context) {
  if (node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const span = node.parentNode;
  const line = span?.parentNode;
  if (span == null || line == null || !isReusableRun(span) || !context.isLine(line)) {
    return null;
  }
  return {
    line: line,
    span: span,
    node: node
  };
}
function firstTargetRange(event) {
  if (typeof event.getTargetRanges !== 'function') {
    return null;
  }
  return event.getTargetRanges()[0] ?? null;
}

// Whether the line's spans, with the edit applied, are exactly the model's
// runs after it (`lineText` is that line of the edited buffer). This is the
// whole eligibility rule: pending styles, links, run-boundary carets and
// emptied runs all fail it.
export function spansMatchRuns(edit, runs, lineText) {
  const spans = edit.line.childNodes;
  if (spans.length !== runs.length) {
    return false;
  }
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const span = spans[i];
    if (!isReusableRun(span) || span.className !== classNameFor(run.styles) || span.dataset.url !== run.url) {
      return false;
    }
    const shown = span === edit.span ? edit.nodeText : span.firstChild.data;
    if (shown !== lineText.slice(run.startInLine, run.endInLine)) {
      return false;
    }
  }
  return true;
}

// Whether the browser did exactly what was planned, and nothing else.
export function nativeEditLanded(edit, isLine, runCount) {
  return edit.node.parentNode === edit.span && edit.span.childNodes.length === 1 && edit.span.parentNode === edit.line && edit.line.childNodes.length === runCount && isLine(edit.line) && edit.node.data === edit.nodeText;
}
//# sourceMappingURL=NativeEdit.js.map
