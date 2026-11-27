"use strict";

/**
 * Parser options accepted by the web bridge: the public {@link Md4cFlags} plus
 * the flags the WASM parser understands but the component API does not expose.
 *
 * `permissiveAutolinks` has to stay settable because the two web call sites
 * want opposite values. The display component omits it and relies on the
 * `true` default, which is what renders bare URLs as links and matches the
 * native parsers, where the flag defaults on at every layer. The input editor
 * forces it off so its own autolink layer owns bare URLs. It is kept off
 * `Md4cFlags` rather than exposed because a public prop would be silently
 * ignored on iOS and Android, neither of which forwards it to its parser.
 */

// Caching the Promise (not the resolved value) means concurrent callers share
// a single WASM initialization — no duplicate loading.
let parserPromise = null;
// Set once the WASM is up, so later parses can run synchronously in render.
let loadedParser = null;
const parserReadyListeners = new Set();

// SINGLE_FILE=1 inlines the WASM binary as base64 inside md4c.js, so no
// network fetch is needed — only a one-time decode + compile on first call.
function initializeParser() {
  if (!parserPromise) {
    parserPromise = import('./wasm/md4c').then(module => module.default()).then(wasmModule => wasmModule.cwrap('parseMarkdown', 'string', ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'])).then(wrapped => {
      const parse = wrapped;
      loadedParser = parse;
      parserReadyListeners.forEach(listener => listener());
      return parse;
    }).catch(error => {
      parserPromise = null;
      throw error;
    });
  }
  return parserPromise;
}

/** Starts the WASM load, or retries one that failed. */
export function loadParser() {
  return initializeParser().then(() => {});
}

/** Whether {@link parseMarkdownSync} can run. */
export function isParserReady() {
  return loadedParser !== null;
}

/** Calls `listener` once the WASM load finishes. */
export function subscribeParserReady(listener) {
  parserReadyListeners.add(listener);
  return () => {
    parserReadyListeners.delete(listener);
  };
}

// Starts the WASM load ahead of the first parse, so that parse settles in
// microtasks. Skipped without a `window` (SSR), where no editor will mount.
export function preloadParser() {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  // A failure is left to the first real parse, which retries the load.
  return loadParser().catch(() => {});
}
function isASTNode(value) {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}
export async function parseMarkdown(markdown, flags = {}) {
  return runParser(await initializeParser(), markdown, flags);
}

/**
 * Parses without waiting, for callers that render the result in the same
 * pass. Throws when the WASM has not loaded yet: check {@link isParserReady}.
 */
export function parseMarkdownSync(markdown, flags = {}) {
  if (!loadedParser) {
    throw new Error('WASM parser is not loaded');
  }
  return runParser(loadedParser, markdown, flags);
}
function runParser(parse, markdown, {
  underline = false,
  latexMath = true,
  superscript = false,
  subscript = false,
  highlight = false,
  hardSoftBreaks = false,
  preserveBlankLines = false,
  admonitions = true,
  permissiveAutolinks = true
}) {
  const result = JSON.parse(parse(markdown, underline ? 1 : 0, latexMath ? 1 : 0, superscript ? 1 : 0, subscript ? 1 : 0, highlight ? 1 : 0, hardSoftBreaks ? 1 : 0, preserveBlankLines ? 1 : 0, admonitions ? 1 : 0, permissiveAutolinks ? 1 : 0));
  if (!isASTNode(result)) {
    throw new Error('WASM parser returned invalid AST');
  }
  return result;
}
//# sourceMappingURL=parseMarkdown.js.map
