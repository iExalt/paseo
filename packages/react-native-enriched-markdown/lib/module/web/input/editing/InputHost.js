"use strict";

import { BlockStore, lineAtPosition } from "../formatting/BlockStore.js";
import { FormattingStore } from "../formatting/FormattingStore.js";
import { parseToPlainTextAndRanges } from "../formatting/InputParser.js";
import { serialize } from "../formatting/MarkdownSerializer.js";
import { DomRenderer } from "../render/DomRenderer.js";
import { computeStyleRuns, ParagraphProjector } from "../render/InputProjection.js";
import { ENRM_INPUT_CLASS, injectInputStyles } from "../render/inputStyles.js";
import { isListItem } from "../model/blocks.js";
import { BlockEditCoordinator } from "./BlockEditCoordinator.js";
import { EditHistory } from "./EditHistory.js";
import { EditPipeline } from "./EditPipeline.js";
import { EditSession } from "./EditSession.js";
import { nativeEditLanded, planNativeEdit, spansMatchRuns } from "./NativeEdit.js";
import { isCaret, SelectionMapper, textLengthBefore } from "./SelectionMapper.js";
import { TypingAttributesController } from "./TypingAttributesController.js";
import { buildInputState, copyInputState, sameInputState } from "./InputState.js";
import { clamp, codePointBoundaryAtOrBefore, graphemeLengthBefore, graphemeLengthAfter, isCodePointBoundary, isWhitespace } from "../utils.js";

// Natives use a private pasteboard type; on the web `text/markdown` is the
// standard one, so other editors can read it too.
const MARKDOWN_MIME_TYPE = 'text/markdown';

// A paste is an event: nothing awaits its parse to take a failure.
function reportPasteError(error) {
  console.error('[EnrichedMarkdown - InputHost] paste failed', error);
}

// Typed per event, so a table entry cannot pair a handler with the wrong one.

export class InputHost {
  formattingStore = new FormattingStore();
  blockStore = new BlockStore();
  // Told about every text and style change as it happens (`applyModelEdit`,
  // `toggleInlineStyle`), so a render re-projects only the touched lines.
  projector = new ParagraphProjector(this.formattingStore);
  session = new EditSession();
  history = new EditHistory();
  // The only attributes teardown removes. `data-empty` is listed from the
  // start because `render` toggles it rather than setting it.
  ownedAttributes = ['data-empty'];
  text = '';
  selection = {
    start: 0,
    end: 0
  };
  selectionBackward = false;
  // Work that would write the DOM while an IME owns it - commands, imports,
  // imperative selection moves - waits here for the composition to end.
  deferredUntilCompositionEnd = [];
  // Links snap only once a drag ends (as on iOS); rewriting the selection
  // mid-drag fights the browser for its anchor.
  pointerSelecting = false;
  // An edit the browser was left to perform (see `NativeEdit`), already in
  // the model and waiting for its `input` to be checked and rendered.
  pendingNativeEdit = null;
  destroyed = false;
  attached = false;
  // Lets an import still parsing tell that a later one has overtaken it. Only
  // imports count: a user edit cannot race an import, because the editor is
  // inert while one is parsing.
  importGeneration = 0;
  pendingImports = 0;
  editable = true;
  markdownEmitEnabled = true;
  lastEmittedMarkdown = null;
  lastEmittedState = null;
  lastEmittedHistory = {
    canUndo: false,
    canRedo: false
  };
  // WebKit raises one `historyUndo` per entry on its own stack for a single
  // Undo command once a scripted render has split that stack, so only the
  // first history input in a task is a step the user asked for.
  historyInputPending = false;
  constructor(root, callbacks = {}, options = {}) {
    this.root = root;
    this.callbacks = callbacks;
    this.pipeline = new EditPipeline(this.formattingStore, this.blockStore);
    this.blockCoordinator = new BlockEditCoordinator(this.blockStore);
    this.typing = new TypingAttributesController(this.formattingStore);
    this.renderer = new DomRenderer(root);
    this.mapper = new SelectionMapper(root, this.renderer);
    // Built here rather than as field initializers: the handlers are fields
    // declared further down, so they do not exist yet when those run.
    this.rootListeners = [['beforeinput', this.handleBeforeInput], ['input', this.handleInput], ['keydown', this.handleKeyDown], ['pointerdown', this.handlePointerDown], ['compositionstart', this.handleCompositionStart], ['compositionend', this.handleCompositionEnd], ['focus', this.handleFocus], ['blur', this.handleBlur], ['copy', this.handleCopy], ['cut', this.handleCut], ['paste', this.handlePaste]];
    this.documentListeners = [['selectionchange', this.handleSelectionChange], ['pointerup', this.handlePointerUp], ['pointercancel', this.handlePointerUp]];
    injectInputStyles();
    root.classList.add(ENRM_INPUT_CLASS);
    this.setOwnedAttribute('contenteditable', 'true');
    // A consumer may be passing these through as props; theirs wins, and
    // `destroy` leaves it in place.
    if (setAttributeIfAbsent(root, 'role', 'textbox')) {
      this.ownedAttributes.push('role');
    }
    if (setAttributeIfAbsent(root, 'aria-multiline', 'true')) {
      this.ownedAttributes.push('aria-multiline');
    }
    if (options.spellCheck !== undefined) {
      root.setAttribute('spellcheck', String(options.spellCheck));
      this.ownedAttributes.push('spellcheck');
    }
    // Not configurable, unlike spellcheck: grammar and translation extensions
    // rewrite the text nodes under us, and nothing in this model can see that
    // happen.
    this.setOwnedAttribute('data-gramm', 'false');
    this.setOwnedAttribute('translate', 'no');
    this.addListeners();
    this.render();
  }

  // Keeps the document, its DOM and the undo history, so that `attach` picks
  // up where this left off. React tears a layout effect down and runs it
  // again over the same node - an `<Activity>` hidden and shown, a Suspense
  // boundary suspending again, StrictMode's double run - and destroying the
  // host there would throw the user's text away.
  detach() {
    if (this.destroyed || !this.attached) {
      return;
    }
    // Nothing will report these once the listeners are gone.
    this.settleNativeEdit();
    if (this.session.isComposing) {
      this.endComposition();
    }
    this.pointerSelecting = false;
    this.removeListeners();
    // A node left in the page (hidden, or kept by whoever owns it) must not
    // take typing that nothing would see. `attach` restores both.
    this.root.removeAttribute('contenteditable');
    this.root.removeAttribute('data-empty');
  }
  attach() {
    if (this.destroyed || this.attached) {
      return;
    }
    this.addListeners();
    this.setEditable(this.editable);
    // Whatever touched the DOM while nothing was listening is undone: the
    // renderer rebuilds lines that no longer match what it rendered. This
    // also puts `data-empty` back.
    this.render();
  }
  get isAttached() {
    return this.attached;
  }
  addListeners() {
    const root = this.root;
    for (const [type, listener] of this.rootListeners) {
      root.addEventListener(type, listener);
    }
    for (const [type, listener] of this.documentListeners) {
      root.ownerDocument.addEventListener(type, listener);
    }
    this.attached = true;
  }
  removeListeners() {
    const root = this.root;
    for (const [type, listener] of this.rootListeners) {
      root.removeEventListener(type, listener);
    }
    for (const [type, listener] of this.documentListeners) {
      root.ownerDocument.removeEventListener(type, listener);
    }
    this.attached = false;
  }
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.session.endComposition();
    this.pendingNativeEdit = null;
    // Deferred commands no-op once destroyed; a deferred `setValue` resolves
    // and returns false, so the import queue behind it does not stall.
    this.runDeferredCommands();
    if (this.attached) {
      this.removeListeners();
    }

    // Leave nothing editable behind. A consumer that owns the node and keeps
    // it would otherwise hand the user a contentEditable with no model
    // underneath, which accepts typing and reports none of it.
    for (const attribute of this.ownedAttributes) {
      this.root.removeAttribute(attribute);
    }
    this.root.classList.remove(ENRM_INPUT_CLASS);
    this.root.replaceChildren();
  }
  get value() {
    return this.text;
  }
  getMarkdown() {
    return serialize(this.text, this.formattingStore.allRanges, this.blockStore.allRanges);
  }

  // The prop path (`defaultValue` and friends): loads the markdown without
  // reporting it back, because the app already has this value. Matches
  // Android, which holds its importing phase across the whole import, and
  // iOS, whose `importMarkdown` emits nothing.
  async importValue(markdown) {
    await this.loadValue(markdown);
  }
  focus() {
    if (this.destroyed) {
      return;
    }
    this.root.focus();
  }

  // Writes the attribute, as the constructor does, rather than the
  // `contentEditable` IDL property, so the node reads the same whether set at
  // construction or flipped later. Teardown already owns the name.
  setEditable(editable) {
    if (this.destroyed) {
      return;
    }
    this.editable = editable;
    this.root.setAttribute('contenteditable', editable ? 'true' : 'false');
  }

  // Mirrors native's `isOnChangeMarkdownSet` prop. Every edit would otherwise
  // serialize the whole document, and a wrapper that forwards the event
  // through a stable closure cannot be told apart from a real listener by
  // inspecting the callback.
  setMarkdownEmitEnabled(enabled) {
    this.markdownEmitEnabled = enabled;
    // Whatever was emitted before the gap says nothing about what the
    // listener last saw.
    this.lastEmittedMarkdown = null;
  }

  // In the root's content coordinates (padding box plus scroll offset), as
  // the natives report it. Reads the DOM caret, since the model selection
  // trails it until the queued `selectionchange` fires.
  caretRect() {
    const domSelection = this.readDomSelection();
    const offset = domSelection?.selection.start ?? this.selection.start;
    const box = this.caretBoxAtOffset(offset);
    if (box === null) {
      return null;
    }
    const rootRect = this.root.getBoundingClientRect();
    return {
      x: box.left - rootRect.left - this.root.clientLeft + this.root.scrollLeft,
      y: box.top - rootRect.top - this.root.clientTop + this.root.scrollTop,
      // Nothing laid out (a detached editor) has no caret to give a width.
      width: isZeroBox(box) ? 0 : caretWidth(this.root.ownerDocument),
      height: box.height
    };
  }

  // The caret's box in viewport coordinates; all zeros where nothing is laid
  // out.
  caretBoxAtOffset(offset) {
    const position = this.mapper.domPositionFromModelOffset(offset);
    if (position === null) {
      return null;
    }
    return caretBoxAt(this.root.ownerDocument, position);
  }
  blur() {
    if (this.destroyed) {
      return;
    }
    this.root.blur();
  }

  // The imperative command path: loads the markdown and then reports it, the
  // way iOS's `setValue:` command re-emits once the import returns. Keeping
  // the two apart matters at the wrapper, where one `setValue` serving both
  // would make mounting with a `defaultValue` fire `onChangeText` with the
  // value the app just supplied.
  async setValue(markdown) {
    if (await this.loadValue(markdown)) {
      this.emitTextEdited();
    }
  }

  // Inert for the whole asynchronous parse, not just the synchronous model
  // write after it, as native's import owns its whole body: a keystroke typed
  // meanwhile would be silently overwritten by the value landing afterwards.
  async parseInert(markdown) {
    this.pendingImports++;
    try {
      return await parseToPlainTextAndRanges(markdown);
    } finally {
      this.pendingImports--;
    }
  }

  // Returns whether the import was applied: a second import started while
  // this one was parsing supersedes it, and so does teardown.
  async loadValue(markdown) {
    const generation = ++this.importGeneration;
    const parsed = await this.parseInert(markdown);
    if (this.destroyed || generation !== this.importGeneration) {
      return false;
    }
    // Rewriting every node under a running IME would hand its leftovers to a
    // read-back that diffs them against the new model.
    if (this.session.isComposing) {
      await new Promise(resolve => this.deferredUntilCompositionEnd.push(resolve));
      if (this.destroyed || generation !== this.importGeneration) {
        return false;
      }
    }
    const {
      plainText,
      formattingRanges,
      blockRanges
    } = parsed;
    this.settleNativeEdit();
    this.session.scoped('importing', () => {
      this.text = plainText;
      this.formattingStore.setRanges(formattingRanges);
      this.blockStore.setRanges(blockRanges);
      this.projector.invalidate();
      this.selection = {
        start: plainText.length,
        end: plainText.length
      };
      this.selectionBackward = false;
      // A new value is a new document, as native's `setText` makes it.
      this.history.clear();
    });
    // A style toggled at the caret before the load belongs to the old
    // document; the next keystroke takes what the new caret sits next to.
    this.typing.resetForSelectionChange(this.selection);
    this.render();
    this.emitHistoryState();
    return true;
  }

  // Clamps the way iOS does - into the buffer, then `end` up to `start`, so a
  // reversed range collapses rather than flipping - and additionally snaps off
  // the seam inside a surrogate pair, which UIKit does for us there but which
  // nothing here would catch before the next edit split the pair.
  // Links are atomic, as on both natives.
  setSelection(start, end) {
    if (this.destroyed) {
      return;
    }
    this.settleNativeEdit();
    if (this.deferWhileComposing(() => this.setSelection(start, end))) {
      return;
    }
    const max = this.text.length;
    const clampedStart = clamp(toOffset(start), 0, max);
    const snapped = {
      start: codePointBoundaryAtOrBefore(this.text, clampedStart),
      end: codePointBoundaryAtOrBefore(this.text, clamp(toOffset(end), clampedStart, max))
    };
    this.selection = this.formattingStore.selectionAdjustedForAtomicLinks(snapped.start, snapped.end) ?? snapped;
    this.selectionBackward = false;
    // Nothing in the model changed, so only the DOM selection moves.
    this.session.scoped('formatting', () => this.writeSelectionToDom());
    this.resetTypingAfterSelectionMove();
    this.emitSelectionMoved();
  }
  indentList() {
    this.command(() => this.changeListDepthBy(1));
  }
  outdentList() {
    this.command(() => this.changeListDepthBy(-1));
  }
  toggleUnorderedList() {
    this.command(() => this.toggleListType('unordered-list-item'));
  }
  toggleOrderedList() {
    this.command(() => this.toggleListType('ordered-list-item'));
  }
  toggleBold() {
    this.toggleInlineStyle('strong');
  }
  toggleItalic() {
    this.toggleInlineStyle('em');
  }
  toggleUnderline() {
    this.toggleInlineStyle('underline');
  }
  toggleStrikethrough() {
    this.toggleInlineStyle('strikethrough');
  }
  toggleSpoiler() {
    this.toggleInlineStyle('spoiler');
  }
  toggleHeading(level) {
    this.command(() => {
      this.recordFormatting();
      const changed = this.session.scoped('processing', () => this.blockCoordinator.toggleHeading(level, this.selection, this.text));
      if (!changed) {
        this.history.discardFormatting();
        return;
      }
      this.render();
      this.emitFormattingChanged();
    });
  }
  undo() {
    this.command(() => {
      const step = this.history.undo(this.captureSnapshot);
      if (step !== null) {
        this.restore(step.edits, 'undo', step.target);
      }
    });
  }
  redo() {
    this.command(() => {
      const step = this.history.redo();
      if (step !== null) {
        this.restore(step.edits, 'redo', step.target);
      }
    });
  }

  // Mid-composition a command would rewrite the nodes under the IME, so it
  // waits for the composition to end. After teardown it does nothing: the
  // node may still belong to the consumer, and nothing may write into it.
  command(run) {
    if (this.destroyed) {
      return;
    }
    this.settleNativeEdit();
    if (!this.deferWhileComposing(run)) {
      run();
    }
  }
  deferWhileComposing(run) {
    if (!this.session.isComposing) {
      return false;
    }
    this.deferredUntilCompositionEnd.push(() => {
      if (!this.destroyed) {
        run();
      }
    });
    return true;
  }
  runDeferredCommands() {
    const deferred = this.deferredUntilCompositionEnd;
    this.deferredUntilCompositionEnd = [];
    for (const run of deferred) {
      if (this.session.isComposing) {
        // A new composition began from inside one of them; the rest wait.
        this.deferredUntilCompositionEnd.push(run);
        continue;
      }
      run();
    }
  }
  handleBeforeInput = event => {
    if (!this.editable) {
      event.preventDefault();
      return;
    }
    // The browser owns the DOM during a composition and `beforeinput` for
    // `insertCompositionText` is not cancelable in every engine, so the model
    // stays out of the way and reads the result back on `compositionend`.
    if (event.isComposing || this.session.isComposing) {
      return;
    }
    this.settleNativeEdit();
    // An import is parsing: the value the app asked for is about to replace
    // everything, so an edit now would be overwritten anyway.
    if (this.pendingImports === 0 && this.letBrowserEdit(event)) {
      return;
    }
    // Default-deny: unhandled input types become no-ops, never native edits.
    event.preventDefault();
    if (this.pendingImports > 0) {
      return;
    }
    this.syncSelectionFromDom();
    switch (event.inputType) {
      // Corrections address their own word, and Safari can send either type.
      case 'insertText':
      case 'insertReplacementText':
        this.replaceTargetRange(event, insertedTextOf(event));
        break;
      // The model owns history, whoever wrote the DOM: the browser's own
      // stack holds the native-edit fast path's keystrokes and nothing else,
      // so replaying it would drift from the model.
      case 'historyUndo':
      case 'historyRedo':
        this.historyInput(event.inputType);
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        this.insertNewline();
        break;
      // The browser's own formatting commands - a menu, iOS's B/I/U bar, a
      // shortcut the keydown handler did not take - run the model's toggles.
      case 'formatBold':
        this.toggleBold();
        break;
      case 'formatItalic':
        this.toggleItalic();
        break;
      case 'formatUnderline':
        this.toggleUnderline();
        break;
      case 'formatStrikeThrough':
        this.toggleStrikethrough();
        break;
      // Deletes prefer the platform's target range: word and visual-line
      // bounds depend on locale and layout. The scanners are the fallback.
      case 'deleteContentBackward':
        this.deleteBackwardTo(event, this.selection.start - graphemeLengthBefore(this.text, this.selection.start), 'deleting');
        break;
      case 'deleteContentForward':
        this.deleteForwardTo(event, this.selection.end + graphemeLengthAfter(this.text, this.selection.end), 'deleting');
        break;
      case 'deleteWordBackward':
        this.deleteBackwardTo(event, wordStartBefore(this.text, this.selection.start));
        break;
      case 'deleteWordForward':
        this.deleteForwardTo(event, wordEndAfter(this.text, this.selection.end));
        break;
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
        this.deleteBackwardTo(event, lineStartBefore(this.text, this.selection.start));
        break;
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
        this.deleteForwardTo(event, lineEndAfter(this.text, this.selection.end));
        break;
      // A paste or cut normally arrives as a ClipboardEvent, which
      // `handlePaste` / `handleCut` take and cancel, so these never follow.
      // With ClipboardEvents switched off (`dom.event.clipboardevents.enabled`
      // in hardened Firefox) they are all there is.
      case 'insertFromPaste':
        if (!this.clipboardEventHandled) {
          this.pasteFrom(event.dataTransfer);
        }
        break;
      case 'deleteByCut':
        if (!this.clipboardEventHandled) {
          this.replaceTargetRange(event, '');
        }
        break;
      // Still deliberately denied: `insertFromDrop`, which needs a
      // caret-from-point mapping to know where the drop landed. Denying it
      // is inert rather than wrong.
      default:
        break;
    }
  };
  historyInput(inputType) {
    if (this.historyInputPending) {
      return;
    }
    this.historyInputPending = true;
    setTimeout(() => {
      this.historyInputPending = false;
    }, 0);
    if (inputType === 'historyUndo') {
      this.undo();
    } else {
      this.redo();
    }
  }

  // Applies the edit to the model and lets the browser write the DOM when
  // that matches what a render would (see `NativeEdit`). False when the edit
  // is not a candidate; a candidate whose runs differ is cancelled and
  // rendered here.
  letBrowserEdit(event) {
    if (this.renderer.hasDirtyLines) {
      return false;
    }
    const edit = planNativeEdit(event, {
      root: this.root,
      isLine: this.isRenderedLine,
      modelOffsetFromDom: (node, offset) => this.mapper.modelOffsetFromDom(node, offset)
    });
    if (edit === null) {
      return false;
    }
    const {
      editStart,
      deletedText,
      insertedText
    } = edit;
    // A Backspace into a link deletes all of it, which is the model's edit
    // to make.
    if (deletedText.length > 0 && this.formattingStore.isStyleActiveInRange('link', editStart, editStart + deletedText.length)) {
      return false;
    }
    this.syncSelectionFromDom();
    this.applyModelEdit(edit, insertedText.length > 0 ? 'typing' : 'deleting');
    const line = lineAtPosition(editStart, this.text);
    const runs = computeStyleRuns(this.formattingStore.allRanges, line.start, line.end);
    if (!spansMatchRuns(edit, runs, this.text.slice(line.start, line.end))) {
      event.preventDefault();
      this.renderEdit();
      return true;
    }
    this.pendingNativeEdit = {
      edit,
      runCount: runs.length
    };
    // `input` follows within the same task; the timer is for an engine that
    // lets the event through and then performs nothing.
    setTimeout(() => this.settleNativeEdit(), 0);
    return true;
  }

  // Once the browser has made a native edit: a no-op render if it landed as
  // planned, otherwise its line is rewritten from the model.
  settleNativeEdit() {
    const pending = this.pendingNativeEdit;
    if (pending === null || this.destroyed) {
      return;
    }
    this.pendingNativeEdit = null;
    if (!nativeEditLanded(pending.edit, this.isRenderedLine, pending.runCount)) {
      const index = this.renderer.indexOfLine(pending.edit.line);
      if (index === -1) {
        this.renderer.invalidate();
      } else {
        this.renderer.markLinesDirty(index, index);
      }
    }
    this.render();
    this.emitTextEdited();
  }
  isRenderedLine = node => this.renderer.indexOfLine(node) !== -1;
  syncSelectionFromDom() {
    const mapped = this.readDomSelection();
    if (mapped !== null) {
      this.selection = mapped.selection;
      this.selectionBackward = mapped.backward;
    }
  }

  // The DOM selection in model offsets, snapped off surrogate seams like
  // `setSelection`'s arguments.
  readDomSelection() {
    const domSelection = this.root.ownerDocument.getSelection();
    if (domSelection === null) {
      return null;
    }
    const points = this.mapper.modelSelectionFromDom(domSelection);
    if (points === null) {
      return null;
    }
    const anchor = this.snapToModel(points.anchor);
    const focus = this.snapToModel(points.focus);
    return {
      selection: {
        start: Math.min(anchor, focus),
        end: Math.max(anchor, focus)
      },
      backward: focus < anchor
    };
  }
  snapToModel(offset) {
    return codePointBoundaryAtOrBefore(this.text, clamp(offset, 0, this.text.length));
  }

  // Tab never reaches beforeinput (the browser moves focus). The history
  // shortcuts do as `historyUndo`/`historyRedo`, but not cancelably in every
  // engine, so they are taken here before the browser undoes anything itself.
  // On a list line Tab / Shift+Tab change the depth; elsewhere Tab types a
  // tab character, and Shift+Tab is left to the browser, so focus can always
  // move backwards out of the editor. A modified Tab (Ctrl/Cmd/Alt) is never
  // taken.
  handleTab(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    this.settleNativeEdit();
    this.syncSelectionFromDom();
    const onList = isListItem(this.blockStore.blockAt(this.selection.start, this.text));
    if (!onList && event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (this.pendingImports > 0) {
      return;
    }
    if (!onList) {
      this.command(() => this.replaceSelection('\t'));
    } else if (event.shiftKey) {
      this.outdentList();
    } else {
      this.indentList();
    }
  }
  handleKeyDown = event => {
    if (!this.editable || event.isComposing || this.session.isComposing) {
      return;
    }
    if (event.key === 'Tab') {
      this.handleTab(event);
      return;
    }
    const apple = isApplePlatform(this.root.ownerDocument.defaultView?.navigator ?? null);
    const shortcut = historyShortcut(event, apple) ?? formatShortcut(event, apple);
    if (shortcut === null) {
      return;
    }
    event.preventDefault();
    if (this.pendingImports > 0) {
      return;
    }
    switch (shortcut) {
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case 'bold':
        this.toggleBold();
        break;
      case 'italic':
        this.toggleItalic();
        break;
      case 'underline':
        this.toggleUnderline();
        break;
    }
  };
  handleCompositionStart = () => {
    this.settleNativeEdit();
    if (this.pendingImports === 0) {
      this.syncSelectionFromDom();
    }
    this.session.beginComposition();
    // A composition is an undo step of its own.
    this.history.breakGroup();
    // Rewrite the IME's lines when it ends, even if the text matches.
    this.renderer.markLinesDirty(this.mapper.lineIndexAt(this.selection.start), this.mapper.lineIndexAt(this.selection.end));
    // The placeholder would draw over the composed text.
    this.root.toggleAttribute('data-empty', false);
  };
  handleCompositionEnd = () => {
    this.endComposition();
  };
  endComposition() {
    this.session.endComposition();
    this.recoverComposition('composition');
    this.history.breakGroup();
    this.runDeferredCommands();
  }

  // `input` only reports DOM changes the browser made itself:
  // - a native edit, settled here;
  // - a composition update, followed in the model without rendering so
  //   `value` and `getMarkdown` include the word still being composed (Chrome
  //   Android composes until a space), as Android native does;
  // - an edit that escaped `preventDefault` (Android Chrome, non-cancelable
  //   types, `execCommand`, extensions), read back like a composition.
  handleInput = event => {
    if (this.destroyed) {
      return;
    }
    const composing = event.isComposing || this.session.isComposing;
    if (!composing && this.pendingNativeEdit !== null) {
      this.settleNativeEdit();
      return;
    }
    if (composing) {
      if (this.editable && this.pendingImports === 0) {
        this.readBackFromDom({
          render: false,
          kind: 'composition'
        });
      }
      return;
    }
    this.renderer.markLinesDirty(this.mapper.lineIndexAt(this.selection.start), this.mapper.lineIndexAt(this.selection.end));
    if (this.pendingImports > 0) {
      // The import is about to replace everything; put the model back.
      this.renderer.invalidate();
      this.render();
      return;
    }
    this.recoverComposition('other');
  };
  handlePointerDown = event => {
    this.pointerSelecting = event.isPrimary && event.button === 0;
  };
  handlePointerUp = () => {
    if (!this.pointerSelecting) {
      return;
    }
    this.pointerSelecting = false;
    // The gesture's last selection change came while it was still running
    // and was left unsnapped.
    this.handleSelectionChange();
  };
  handleFocus = () => {
    // The browser places its own caret when a contentEditable takes focus, and
    // `writeSelectionToDom` declines to write while the editor is unfocused.
    // Without this, a `setSelection` issued before the focus would be
    // overwritten by that caret the moment the focus arrived.
    if (this.destroyed) {
      return;
    }
    this.session.scoped('formatting', () => this.writeSelectionToDom());
    // As natives emit on every selection callback, deduplicated: focusing a
    // freshly loaded editor tells a toolbar what the caret sits in.
    this.emitState();
  };
  handleBlur = () => {
    // A composition abandoned by a blur does not always fire
    // `compositionend`, and a latched composition flag makes the editor
    // read-only: every `beforeinput` short-circuits.
    if (this.session.isComposing) {
      this.endComposition();
    }
  };

  // A composition that ends on a read-only editor - `editable` was flipped
  // while the IME held the DOM - must not be read back as an edit, but the
  // nodes the IME left behind still have to go, so the model is rendered over
  // them instead.
  recoverComposition(kind) {
    if (this.editable) {
      this.readBackFromDom({
        kind
      });
      return;
    }
    this.renderer.invalidate();
    this.render();
  }
  handleCut = event => {
    // The UA writes the clipboard and then performs the deletion, whose
    // `beforeinput` arrives as `deleteByCut` and gets cancelled. Taking over
    // both halves is what stops a cut from copying the text and leaving it
    // in place. On a read-only editor both halves stay cancelled, the way
    // iOS and Android drop Cut from the menu and leave Copy, which is not
    // intercepted here at all.
    event.preventDefault();
    if (!this.editable || this.session.isComposing || this.pendingImports > 0) {
      return;
    }
    this.settleNativeEdit();
    this.syncSelectionFromDom();
    const {
      start,
      end
    } = this.selection;
    if (start === end) {
      return;
    }
    if (event.clipboardData) {
      this.writeClipboard(event.clipboardData, start, end);
    }
    this.markClipboardEventHandled();
    this.applyEdit({
      editStart: start,
      deletedText: this.text.slice(start, end),
      insertedText: ''
    });
  };

  // The browser would copy the rendered text only. Like both natives, the
  // clipboard also gets the selection as markdown, which a paste into this
  // editor (or any editor reading `text/markdown`) brings back formatted.
  handleCopy = event => {
    if (this.session.isComposing || event.clipboardData === null) {
      return;
    }
    this.settleNativeEdit();
    this.syncSelectionFromDom();
    const {
      start,
      end
    } = this.selection;
    if (start === end) {
      return;
    }
    event.preventDefault();
    this.writeClipboard(event.clipboardData, start, end);
  };
  writeClipboard(data, start, end) {
    data.setData('text/plain', this.text.slice(start, end));
    data.setData(MARKDOWN_MIME_TYPE, this.serializeRange(start, end));
  }

  // The markdown of [start, end): ranges and blocks clipped to it, as iOS's
  // `serializeSelectedRange` does, so a selection starting inside a heading
  // still copies as a heading.
  serializeRange(start, end) {
    const clip = range => range.end <= start || range.start >= end ? [] : [{
      ...range,
      start: Math.max(range.start, start) - start,
      end: Math.min(range.end, end) - start
    }];
    return serialize(this.text.slice(start, end), this.formattingStore.allRanges.flatMap(clip), this.blockStore.allRanges.flatMap(clip));
  }

  // A handled cut or paste is cancelled, so its `beforeinput` should never
  // follow; if an engine raises one anyway, it must not apply the edit twice.
  clipboardEventHandled = false;
  markClipboardEventHandled() {
    this.clipboardEventHandled = true;
    setTimeout(() => {
      this.clipboardEventHandled = false;
    }, 0);
  }
  handlePaste = event => {
    event.preventDefault();
    if (!this.editable || this.session.isComposing || this.pendingImports > 0) {
      return;
    }
    this.settleNativeEdit();
    this.markClipboardEventHandled();
    this.syncSelectionFromDom();
    this.pasteFrom(event.clipboardData);
  };

  // The markdown flavor this editor (or another one) wrote, else the plain
  // text - which is parsed as markdown too, as both natives do, so pasted
  // "- item" or "**bold**" arrives formatted.
  pasteFrom(data) {
    const pasted = data?.getData(MARKDOWN_MIME_TYPE) || data?.getData('text/plain') || '';
    if (pasted.length > 0) {
      this.insertText(pasted).catch(reportPasteError);
    }
  }
  handleSelectionChange = () => {
    // This guard only catches a side effect delivered on the same stack as
    // the write. `selectionchange` is queued on the user interaction task
    // source instead, so by delivery time the render's scope has exited and
    // the phase is back to idle. What actually swallows the echo of our own
    // render is the offset comparison at the end: the mapper's round trip is
    // lossless, so a caret we just restored maps back to the offset already
    // held. Do not drop it as redundant.
    if (this.session.shouldSuppressSelectionSideEffects || this.session.isComposing || this.destroyed) {
      return;
    }
    // A render dirties any selection inside the nodes it rewrites (replacing a
    // text node's data collapses the live ranges within it), and
    // `writeSelectionToDom` only puts it back while the editor has focus.
    // Without this, that unrestored selection arrives here and reports a
    // change for a document the user never touched.
    if (!this.hasFocus()) {
      return;
    }
    this.settleNativeEdit();
    const domSelection = this.root.ownerDocument.getSelection();
    const read = this.readDomSelection();
    if (domSelection === null || read === null) {
      return;
    }
    // Links are atomic, as on both natives. A drag in progress is left alone;
    // `handlePointerUp` snaps it once it ends.
    const previous = this.selection;
    const atomic = this.pointerSelecting ? null : this.formattingStore.selectionAdjustedForAtomicLinks(read.selection.start, read.selection.end, previous.start === previous.end ? previous.start : null);
    const mapped = atomic ?? read.selection;
    if (mapped.start === this.selection.start && mapped.end === this.selection.end) {
      this.selectionBackward = read.backward;
      // Compared in model offsets, not nodes: the echo of our own write
      // points into nodes a render replaced. An empty line maps a stretched
      // highlight to one offset (see `isCaret`), so the DOM may still need
      // the write.
      if (atomic !== null || isCaret(domSelection) !== (mapped.start === mapped.end)) {
        this.session.scoped('formatting', () => this.writeSelectionToDom());
      }
      // The caret did not move, but a load does not report state (natives
      // emit nothing for a `defaultValue`), so the first click in the editor
      // is where a toolbar learns about the line it lands on. Deduplicated.
      this.emitState();
      return;
    }
    this.selection = mapped;
    this.selectionBackward = read.backward;
    if (atomic !== null) {
      this.session.scoped('formatting', () => this.writeSelectionToDom());
    }
    this.resetTypingAfterSelectionMove();
    this.emitSelectionMoved();
  };

  // Echoes of our own caret writes are swallowed by the offset comparison
  // above, so no grace window is needed (iOS keeps 100 ms).
  resetTypingAfterSelectionMove() {
    this.typing.resetForSelectionChange(this.selection);
    // Typing somewhere else is a new undo step.
    this.history.breakGroup();
  }

  // The browser owns the DOM through a composition, so the composed text
  // lands without the model seeing it; this diffs the rendered text against
  // the model and applies the one edit the composition made.
  //
  // Without this the two diverge permanently - the composed text stays on
  // screen while `value` and `onChangeText` omit it, so the user saves and
  // their text is not there - and whatever nodes the IME left behind go on
  // confusing the selection mapping. The scope is wider than CJK: macOS dead
  // keys, iOS Safari autocorrect and GBoard suggestions all compose.
  //
  // The diff is anchored on the DOM caret (see `diffEdit`). `render: false`
  // is the mid-composition update, while the DOM still belongs to the IME.
  readBackFromDom({
    render = true,
    kind
  }) {
    if (this.destroyed) {
      return;
    }
    const domSelection = this.root.ownerDocument.getSelection();
    const focus = domSelection?.focusNode != null && this.root.contains(domSelection.focusNode) ? {
      node: domSelection.focusNode,
      offset: domSelection.focusOffset
    } : null;
    const {
      text: domText,
      caret
    } = readTextFromDom(this.root, focus);
    if (domText === this.text) {
      // The IME's lines were marked dirty, so this still rewrites them.
      if (render) {
        this.render();
      }
      return;
    }
    const edit = diffEdit(this.text, domText, caret);
    // A lone line break the browser inserted itself (an edit that escaped
    // `beforeinput`) is Enter as well: on an empty list item it exits the
    // list. The model keeps its text, so the line the browser added is only
    // in the DOM, and the renderer rebuilds over it.
    if (edit.deletedText.length === 0 && edit.insertedText === '\n' && this.selection.start === this.selection.end && this.isEmptyListItemAt(this.selection.start)) {
      this.renderer.invalidate();
      this.unlistEmptyListItem(this.selection.start);
      return;
    }
    this.applyEdit(edit, {
      caret: caret === null ? undefined : caret,
      render,
      kind
    });
  }
  insertNewline() {
    const {
      start,
      end
    } = this.selection;
    if (start === end && this.unlistEmptyListItem(start)) {
      return;
    }
    this.replaceSelection('\n');
  }
  isEmptyListItemAt(caret) {
    const line = lineAtPosition(caret, this.text);
    return line.start === line.end && isListItem(this.blockStore.blockAt(caret, this.text));
  }
  unlistEmptyListItem(caret) {
    const block = this.blockStore.blockAt(caret, this.text);
    if (!this.isEmptyListItemAt(caret) || !isListItem(block)) {
      return false;
    }
    this.toggleListType(block.type);
    return true;
  }

  // Backspace at the start of a list item outdents it, or un-lists it at
  // depth 0, instead of merging with the line above.
  outdentListAtLineStart(caret) {
    const line = lineAtPosition(caret, this.text);
    if (caret !== line.start || !isListItem(this.blockStore.blockAt(caret, this.text))) {
      return false;
    }
    this.outdentList();
    return true;
  }
  changeListDepthBy(delta) {
    this.recordFormatting();
    const changed = this.session.scoped('processing', () => this.blockCoordinator.changeListDepthBy(delta, this.selection, this.text));
    if (!changed) {
      this.history.discardFormatting();
    } else {
      this.render();
      this.emitFormattingChanged();
    }
  }
  toggleListType(type) {
    // Also reached from Enter and Backspace, which never run mid-composition.
    this.recordFormatting();
    this.session.scoped('processing', () => this.blockCoordinator.toggleListType(type, this.selection, this.text));
    this.render();
    this.emitFormattingChanged();
  }
  toggleInlineStyle(type) {
    this.command(() => {
      const {
        start,
        end
      } = this.selection;
      // A caret toggle changes no store, so there is nothing to undo; what
      // is typed with it is a step of its own, though.
      if (start !== end) {
        this.recordFormatting();
      } else {
        this.history.breakGroup();
      }
      if (start !== end) {
        this.session.scoped('processing', () => this.formattingStore.toggleStyle(type, start, end, this.text));
        this.projector.stylesChanged(start, end);
      }
      if (start === end) {
        this.typing.toggleStyle(type, start);
        this.emitState();
        return;
      }
      // The store just changed under the selection, so what typing over it
      // carries is re-read from there: typing "XYZ" over a word bolded a
      // moment ago keeps all of it bold, not only the "X" that took the
      // replaced range.
      this.typing.resetForSelectionChange(this.selection);
      this.render();
      this.emitFormattingChanged();
    });
  }

  // The argument is markdown, as the API documents and both natives do
  // (`pasteMarkdown`): it is parsed and inserted at the selection with its
  // styles and blocks, as one undo step, and takes no style pending at the
  // caret. Empty text is a no-op even over a selection. Asynchronous, like an
  // import: the editor is inert while the parse runs. A lone line break is
  // Enter, exiting an empty list item as the key does.
  async insertText(markdown) {
    if (this.destroyed || markdown.length === 0) {
      return;
    }
    const source = normalizeLineEndings(markdown);
    if (source === '\n') {
      this.command(() => this.insertNewline());
      return;
    }
    const parsed = await this.parseInert(source);
    if (this.destroyed) {
      return;
    }
    this.command(() => this.insertParsed(withEdgeWhitespace(source, parsed)));
  }
  insertParsed({
    plainText,
    formattingRanges,
    blockRanges
  }) {
    const {
      start,
      end
    } = this.selection;
    if (plainText.length === 0 && start === end) {
      return;
    }
    const atLineStart = start === 0 || this.text.charCodeAt(start - 1) === 10;
    this.applyModelEdit({
      editStart: start,
      deletedText: this.text.slice(start, end),
      insertedText: plainText
    }, 'other', undefined, false);
    this.session.scoped('processing', () => {
      for (const range of formattingRanges) {
        this.formattingStore.addRange({
          ...range,
          start: range.start + start,
          end: range.end + start
        });
      }
      // A block on the first inserted line only applies when that line
      // starts there; inserted mid-line, the line keeps its own block.
      const blocks = blockRanges.filter(block => block.start > 0 || atLineStart);
      if (blocks.length > 0) {
        this.blockStore.edit(this.text, writer => {
          for (const block of blocks) {
            writer.setBlock(block.type, block.level, block.start + start, block.start + start);
          }
        });
      }
    });
    this.projector.invalidate();
    this.renderEdit();
  }
  replaceSelection(insertedText) {
    const {
      start,
      end
    } = this.selection;
    this.applyEdit({
      editStart: start,
      deletedText: this.text.slice(start, end),
      insertedText
    });
  }
  replaceTargetRange(event, insertedText) {
    const target = this.modelRangeFromTargetRanges(event) ?? this.selection;
    if (insertedText.length === 0 && target.start === target.end) {
      return;
    }
    if (insertedText === '\n' && target.start === this.selection.start && target.end === this.selection.end) {
      this.insertNewline();
      return;
    }
    const deletedText = this.text.slice(target.start, target.end);
    this.applyEdit({
      editStart: target.start,
      deletedText,
      insertedText
    }, {
      kind: deletedText.length === 0 && !insertedText.includes('\n') ? 'typing' : 'other'
    });
  }
  modelRangeFromTargetRanges(event) {
    if (typeof event.getTargetRanges !== 'function') {
      return null;
    }
    const [target] = event.getTargetRanges();
    if (target === undefined) {
      return null;
    }
    const start = this.mapper.modelOffsetFromDom(target.startContainer, target.startOffset);
    const end = this.mapper.modelOffsetFromDom(target.endContainer, target.endOffset);
    if (start === null || end === null) {
      return null;
    }
    const from = this.snapToModel(Math.min(start, end));
    const to = this.snapToModel(Math.max(start, end));
    return {
      start: from,
      end: to
    };
  }

  // Deletes back to the event's target range, else to `fallback`. A fallback
  // that makes no progress (caret at a line start) deletes the newline.
  // `kind` is `deleting` for a single character, so a run of them is one
  // undo step.
  deleteBackwardTo(event, fallback, kind = 'other') {
    const {
      start,
      end
    } = this.selection;
    if (start !== end) {
      this.replaceSelection('');
      return;
    }
    if (this.outdentListAtLineStart(start) || start === 0) {
      return;
    }
    if (this.deleteLinkAt(start - 1) || this.deleteTargetRange(event, kind)) {
      return;
    }
    const from = fallback < start ? fallback : start - graphemeLengthBefore(this.text, start);
    this.deleteRange({
      start: from,
      end: start
    }, kind);
  }
  deleteForwardTo(event, fallback, kind = 'other') {
    const {
      start,
      end
    } = this.selection;
    if (start !== end) {
      this.replaceSelection('');
      return;
    }
    if (end >= this.text.length) {
      return;
    }
    if (this.deleteLinkAt(end) || this.deleteTargetRange(event, kind)) {
      return;
    }
    const to = fallback > end ? fallback : end + graphemeLengthAfter(this.text, end);
    this.deleteRange({
      start: end,
      end: to
    }, kind);
  }
  deleteTargetRange(event, kind) {
    const target = this.modelRangeFromTargetRanges(event);
    if (target === null || target.start >= target.end) {
      return false;
    }
    this.deleteRange(target, kind);
    return true;
  }
  deleteRange({
    start,
    end
  }, kind = 'other') {
    this.applyEdit({
      editStart: start,
      deletedText: this.text.slice(start, end),
      insertedText: ''
    }, {
      kind
    });
  }

  // Deleting into a link deletes all of it: backspace as on both natives,
  // forward delete as on iOS. Deleting one character would leave the rest
  // still linking to the url.
  deleteLinkAt(position) {
    const link = this.formattingStore.rangeOfType('link', position);
    if (link === null) {
      return false;
    }
    this.deleteRange(link);
    return true;
  }

  // The native keystroke choreography: model phase, render phase, then
  // events, in the iOS order.
  // `caret` overrides where the caret lands; `render: false` leaves the DOM
  // to the IME. `kind` decides whether the edit joins the open undo step.
  applyEdit(edit, {
    caret,
    render = true,
    kind = 'other'
  } = {}) {
    this.applyModelEdit(edit, kind, caret);
    if (render) {
      this.renderEdit();
    } else {
      this.emitTextEdited();
    }
  }
  renderEdit() {
    this.render();
    this.scrollCaretIntoView();
    this.emitTextEdited();
  }

  // Text, stores and caret only; no DOM, no events. The one place text
  // changes, and so the one place it is recorded.
  applyModelEdit(edit, kind, caret, withPendingStyles = true) {
    const {
      editStart,
      deletedText,
      insertedText
    } = edit;
    const text = this.text.slice(0, editStart) + insertedText + this.text.slice(editStart + deletedText.length);
    const landing = codePointBoundaryAtOrBefore(text, clamp(caret ?? editStart + insertedText.length, 0, text.length));
    this.history.record(edit, kind, this.captureSnapshot, landing);
    this.session.scoped('processing', () => {
      this.text = text;
      this.pipeline.processTextChange(this.text, {
        editStart,
        deletedText,
        insertedText,
        pendingStyles: withPendingStyles ? this.typing.styles : [],
        pendingStyleRemovals: withPendingStyles ? this.typing.styleRemovals : []
      });
      this.projector.textEdited(editStart, deletedText.length, insertedText, this.text);
      this.selection = {
        start: landing,
        end: landing
      };
      this.selectionBackward = false;
    });
  }

  // The history packs what it keeps, so the live ranges are handed over as
  // they are.
  captureSnapshot = () => ({
    formatting: this.formattingStore.allRanges,
    blocks: this.blockStore.allRanges,
    selection: {
      ...this.selection
    },
    backward: this.selectionBackward
  });

  // Rewinds or replays one history entry: the text by splicing its edits
  // (no pipeline - the ranges come from the snapshot, not from adjusting),
  // then the ranges and selection `target` holds.
  restore(edits, direction, target) {
    const previousText = this.text;
    const previousSelection = this.selection;
    this.session.scoped('processing', () => {
      let text = this.text;
      if (direction === 'undo') {
        for (let i = edits.length - 1; i >= 0; i--) {
          const {
            editStart,
            deletedText,
            insertedText
          } = edits[i];
          text = text.slice(0, editStart) + deletedText + text.slice(editStart + insertedText.length);
        }
      } else {
        for (const {
          editStart,
          deletedText,
          insertedText
        } of edits) {
          text = text.slice(0, editStart) + insertedText + text.slice(editStart + deletedText.length);
        }
      }
      this.text = text;
      // Fresh objects from the history: the stores may mutate them.
      this.formattingStore.setRanges([...target.formatting]);
      this.blockStore.setRanges([...target.blocks]);
      // The ranges come back wholesale, so any line may differ.
      this.projector.invalidate();
      this.selection = {
        ...target.selection
      };
      this.selectionBackward = target.backward;
    });
    this.typing.resetForSelectionChange(this.selection);
    this.render();
    this.scrollCaretIntoView();
    // A step that only restyled leaves the text, and often the selection, as
    // they were: reporting them would tell `onChangeText` about a change that
    // did not happen. State, markdown and history deduplicate themselves.
    if (this.text !== previousText) {
      this.emitText();
    }
    if (this.selection.start !== previousSelection.start || this.selection.end !== previousSelection.end) {
      this.emitSelection();
    }
    this.emitFormattingChanged();
  }
  recordFormatting() {
    this.history.recordFormatting(this.captureSnapshot);
  }

  // A scripted caret write does not scroll. Only after edits: a selection
  // the user moved is already in view.
  scrollCaretIntoView() {
    if (!this.hasFocus()) {
      return;
    }
    const box = this.caretBoxAtOffset(this.selection.end);
    if (box !== null && !isZeroBox(box)) {
      scrollBoxIntoView(this.root, box);
    }
  }
  render() {
    // The IME owns the DOM; the render after `compositionend` catches up.
    if (this.session.isComposing) {
      return;
    }
    this.session.scoped('formatting', () => {
      this.root.toggleAttribute('data-empty', this.text.length === 0 && this.blockStore.isEmpty);
      this.renderer.render(this.projector.project(this.text, this.blockStore.allRanges));
      this.writeSelectionToDom();
    });
  }
  writeSelectionToDom() {
    // Moving the selection under an IME moves its composition with it.
    if (!this.hasFocus() || this.session.isComposing) {
      return;
    }
    const domSelection = this.root.ownerDocument.getSelection();
    if (domSelection === null) {
      return;
    }
    const {
      start,
      end
    } = this.selection;
    const collapsed = start === end;
    const anchorOffset = this.selectionBackward ? end : start;
    const focusOffset = this.selectionBackward ? start : end;
    const current = this.mapper.modelSelectionFromDom(domSelection);
    if (current !== null && current.anchor === anchorOffset && current.focus === focusOffset && isCaret(domSelection) === collapsed) {
      return;
    }
    const anchor = this.mapper.domPositionFromModelOffset(anchorOffset);
    const focus = collapsed ? anchor : this.mapper.domPositionFromModelOffset(focusOffset);
    if (anchor === null || focus === null) {
      return;
    }
    domSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }
  hasFocus() {
    return this.root.contains(this.root.ownerDocument.activeElement);
  }
  setOwnedAttribute(name, value) {
    this.root.setAttribute(name, value);
    this.ownedAttributes.push(name);
  }
  emitText() {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    this.callbacks.onChangeText?.(this.text);
  }
  emitSelection() {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    // Copies: a consumer keeping or mutating what it is handed must not
    // reach into the host.
    this.callbacks.onChangeSelection?.({
      ...this.selection
    });
  }
  emitState() {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    const state = buildInputState(this.formattingStore, this.blockStore, this.typing, this.selection, this.text);
    if (this.lastEmittedState !== null && sameInputState(state, this.lastEmittedState)) {
      return;
    }
    this.lastEmittedState = state;
    this.callbacks.onChangeState?.(copyInputState(state));
  }
  emitMarkdown() {
    if (this.session.shouldSuppressEvents || !this.markdownEmitEnabled || !this.callbacks.onChangeMarkdown) {
      return;
    }
    const markdown = this.getMarkdown();
    if (markdown === this.lastEmittedMarkdown) {
      return;
    }
    this.lastEmittedMarkdown = markdown;
    this.callbacks.onChangeMarkdown(markdown);
  }

  // Only when the answer flips, so typing emits nothing past its first key.
  emitHistoryState() {
    if (this.session.shouldSuppressEvents) {
      return;
    }
    const state = this.history.state;
    if (state.canUndo === this.lastEmittedHistory.canUndo && state.canRedo === this.lastEmittedHistory.canRedo) {
      return;
    }
    this.lastEmittedHistory = state;
    this.callbacks.onChangeHistoryState?.(state);
  }
  emitTextEdited() {
    this.emitText();
    this.emitSelection();
    this.emitState();
    this.emitMarkdown();
    this.emitHistoryState();
  }
  emitFormattingChanged() {
    this.emitState();
    this.emitMarkdown();
    this.emitHistoryState();
  }
  emitSelectionMoved() {
    this.emitSelection();
    this.emitState();
  }
}
// The viewport box of a caret at `position`. Uses the last client rect: at a
// soft wrap the bounding box is anchored at the previous line's end. An empty
// line's caret (before its lone `<br>`) has no rects in Blink or WebKit, so
// the `<br>` stands in: it respects list indent and RTL, and has text height.
function caretBoxAt(document, position) {
  const range = measuringRange(document);
  range.setStart(position.node, position.offset);
  range.collapse(true);
  // Neither is implemented by every DOM (jsdom has neither).
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1] : null;
    if (last !== null && !isZeroBox(last)) {
      return last;
    }
  }
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : ZERO_BOX;
  if (!isZeroBox(rect)) {
    return rect;
  }
  const element = position.node.nodeType === Node.ELEMENT_NODE ? position.node : position.node.parentElement;
  if (element === null) {
    return rect;
  }
  for (const candidate of [lineBreakOf(element), element]) {
    const box = candidate?.getBoundingClientRect();
    if (box !== undefined && !isZeroBox(box)) {
      return {
        left: box.left,
        top: box.top,
        width: 0,
        height: box.height
      };
    }
  }
  return rect;
}

// One `Range` per document for caret measurements, reused rather than
// dropped: every live `Range` is updated by each DOM mutation until it is
// collected, so one per call slows later renders (see `textLengthBefore`).
const measuringRanges = new WeakMap();
function measuringRange(document) {
  let range = measuringRanges.get(document);
  if (range === undefined) {
    range = document.createRange();
    measuringRanges.set(document, range);
  }
  return range;
}
function lineBreakOf(line) {
  for (const child of line.children) {
    if (child.nodeName === 'BR') {
      return child;
    }
  }
  return null;
}
const ZERO_BOX = {
  left: 0,
  top: 0,
  width: 0,
  height: 0
};

// Two physical pixels, as Android reports it (`2f / density`).
function caretWidth(document) {
  return 2 / (document.defaultView?.devicePixelRatio || 1);
}

// `scrollIntoView({ block: 'nearest' })` for a rect: scrolling the run span
// would align a multi-line run by its edge, not by the caret.
function scrollBoxIntoView(element, box) {
  const document = element.ownerDocument;
  const view = document.defaultView;
  let {
    top,
    left
  } = box;
  const {
    width,
    height
  } = box;
  for (let current = element; current !== null && current !== document.body && current !== document.documentElement; current = current.parentElement) {
    if (!isScrollContainer(current)) {
      continue;
    }
    const rect = current.getBoundingClientRect();
    const viewTop = rect.top + current.clientTop;
    const viewLeft = rect.left + current.clientLeft;
    const dy = scrollDelta(top, height, viewTop, current.clientHeight);
    const dx = scrollDelta(left, width, viewLeft, current.clientWidth);
    if (dy === 0 && dx === 0) {
      continue;
    }
    const scrollTop = current.scrollTop;
    const scrollLeft = current.scrollLeft;
    current.scrollTop += dy;
    current.scrollLeft += dx;
    top -= current.scrollTop - scrollTop;
    left -= current.scrollLeft - scrollLeft;
  }
  if (view === null) {
    return;
  }
  const dy = scrollDelta(top, height, 0, view.innerHeight);
  const dx = scrollDelta(left, width, 0, view.innerWidth);
  if (dy !== 0 || dx !== 0) {
    view.scrollBy(dx, dy);
  }
}
function scrollDelta(start, size, viewStart, viewSize) {
  if (start < viewStart) {
    return start - viewStart;
  }
  const overflow = start + size - (viewStart + viewSize);
  // A box taller than the view keeps its start in view.
  return overflow > 0 ? Math.min(overflow, start - viewStart) : 0;
}
function isScrollContainer(element) {
  if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style !== undefined && /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`);
}

// What the natives' Int32 command arguments receive: the fraction dropped,
// NaN as 0 (Android's `getInt`). Infinities are left for the clamp.
function toOffset(value) {
  return Number.isNaN(value) ? 0 : Math.trunc(value);
}
function isZeroBox(box) {
  return box.left === 0 && box.top === 0 && box.width === 0 && box.height === 0;
}
function setAttributeIfAbsent(element, name, value) {
  if (element.hasAttribute(name)) {
    return false;
  }
  element.setAttribute(name, value);
  return true;
}
function isModPressed(event, apple) {
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
function historyShortcut(event, apple) {
  if (event.altKey || !isModPressed(event, apple)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (key === 'y' && !apple && !event.shiftKey) {
    return 'redo';
  }
  return null;
}

// Taken on keydown because not every engine raises a cancelable
// `formatBold` for these.
function formatShortcut(event, apple) {
  if (event.altKey || event.shiftKey || !isModPressed(event, apple)) {
    return null;
  }
  switch (event.key.toLowerCase()) {
    case 'b':
      return 'bold';
    case 'i':
      return 'italic';
    case 'u':
      return 'underline';
    default:
      return null;
  }
}
function isApplePlatform(navigator) {
  const platform = navigator?.userAgentData?.platform ?? navigator?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// `insertText` and `insertReplacementText` carry their text on `data` in some
// engines and in the data transfer in others.
function insertedTextOf(event) {
  return normalizeLineEndings(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
}

// md4c drops the whitespace around a document, which an inserted fragment
// needs: `insertText(' and more')` keeps its space. Put back whatever the
// parse dropped from either end of `source`, shifting the ranges past it.
function withEdgeWhitespace(source, parsed) {
  const leading = /^\s*/.exec(source)[0];
  const trailing = /\s*$/.exec(source)[0];
  if (leading.length === source.length) {
    return {
      plainText: source,
      formattingRanges: [],
      blockRanges: []
    };
  }
  const {
    plainText
  } = parsed;
  const lead = plainText.startsWith(leading) ? '' : leading;
  const trail = plainText.endsWith(trailing) ? '' : trailing;
  const shift = range => ({
    ...range,
    start: range.start + lead.length,
    end: range.end + lead.length
  });
  return {
    plainText: lead + plainText + trail,
    formattingRanges: parsed.formattingRanges.map(shift),
    blockRanges: parsed.blockRanges.map(shift)
  };
}

// The buffer uses bare newlines, so a clipboard's line endings are converted
// rather than stored as text.
function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

// The plain text the DOM shows, one line per element child of the root, and
// `point`'s offset in it (null when outside the root). Walks the DOM as is,
// not through the mapper, which only knows the renderer's own lines.
export function readTextFromDom(root, point = null) {
  const lines = [];
  // Length of `lines.join('\n')` so far.
  let length = 0;
  let caret = null;
  const children = root.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const isLine = node.nodeType === Node.ELEMENT_NODE;
    const text = node.textContent ?? '';
    // A text node an IME or an extension dropped directly under the root
    // belongs to the line it was dropped beside, not to a line of its own.
    const startsLine = isLine || lines.length === 0;
    const nodeStart = startsLine && lines.length > 0 ? length + 1 : length;
    if (point !== null && caret === null) {
      if (point.node === root && point.offset === i) {
        caret = nodeStart;
      } else if (point.node === node || node.contains(point.node)) {
        caret = nodeStart + textLengthBefore(node, point.node, point.offset);
      }
    }
    if (!isLine && text.length === 0) {
      continue;
    }
    if (startsLine) {
      lines.push(text);
    } else {
      lines[lines.length - 1] += text;
    }
    length = nodeStart + text.length;
  }
  if (point !== null && caret === null && point.node === root) {
    caret = length;
  }
  return {
    text: lines.join('\n'),
    caret
  };
}

// The one contiguous edit between two buffers, bounded by their shared prefix
// and suffix. A composition commits as a single replacement, so one window is
// all there is to find.
//
// Where prefix and suffix overlap (`a` + `apple` inserts at 0 or 1), `caret`
// picks the placement ending at it, like ProseMirror's `findDiff`; otherwise
// the longest prefix wins.
export function diffEdit(previous, next, caret = null) {
  const maxShared = Math.min(previous.length, next.length);
  let commonPrefix = 0;
  while (commonPrefix < maxShared && previous[commonPrefix] === next[commonPrefix]) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (commonSuffix < maxShared && previous[previous.length - 1 - commonSuffix] === next[next.length - 1 - commonSuffix]) {
    commonSuffix++;
  }
  let prefix = commonPrefix;
  if (caret !== null && commonPrefix + commonSuffix > maxShared) {
    // The suffix that ends the inserted text at the caret, kept within the
    // range where both windows still hold.
    prefix = clamp(maxShared - next.length + caret, maxShared - commonSuffix, commonPrefix);
  }
  let suffix = Math.min(commonSuffix, maxShared - prefix);

  // The stores index code units, so a boundary inside a surrogate pair would
  // leave half a character on each side of the edit.
  while (prefix > 0 && !isCodePointBoundary(next, prefix)) {
    prefix--;
  }
  while (suffix > 0 && !isCodePointBoundary(next, next.length - suffix)) {
    suffix--;
  }
  return {
    editStart: prefix,
    deletedText: previous.slice(prefix, previous.length - suffix),
    insertedText: next.slice(prefix, next.length - suffix)
  };
}

// Start of the word before `position`: the whitespace immediately before it,
// then the run of non-whitespace before that. A line break bounds the scan,
// so one press never reaches onto the previous line.
function wordStartBefore(text, position) {
  let index = position;
  while (index > 0 && isInlineWhitespace(text[index - 1])) {
    index--;
  }
  while (index > 0 && isWordCharacter(text[index - 1])) {
    index--;
  }
  return index;
}
function wordEndAfter(text, position) {
  let index = position;
  while (index < text.length && isInlineWhitespace(text[index])) {
    index++;
  }
  while (index < text.length && isWordCharacter(text[index])) {
    index++;
  }
  return index;
}
function lineStartBefore(text, position) {
  return text.lastIndexOf('\n', position - 1) + 1;
}
function lineEndAfter(text, position) {
  const next = text.indexOf('\n', position);
  return next === -1 ? text.length : next;
}
function isInlineWhitespace(char) {
  return char !== '\n' && isWhitespace(char);
}
function isWordCharacter(char) {
  return char !== '\n' && !isWhitespace(char);
}
//# sourceMappingURL=InputHost.js.map
