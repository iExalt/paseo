"use strict";

/**
 * Whether `text` has a letter to resolve `dir="auto"` from. Chromium resolves
 * an element with none (digits, punctuation, empty) to LTR instead of
 * inheriting, so such elements must not get `dir="auto"`.
 */
export function hasStrongChar(text) {
  return /\p{L}/u.test(text);
}

/**
 * `hasStrongChar` over the text a parent's `dir="auto"` reads: code blocks
 * carry their own `dir="ltr"` and an image's alt text is not content.
 */
export function hasStrongText(node) {
  if (node.type === 'CodeBlock' || node.type === 'Image') return false;
  if (node.content !== undefined) return hasStrongChar(node.content);
  return node.children?.some(hasStrongText) ?? false;
}

/** Recursively collects plain text content from an AST node's subtree. */
export function extractNodeText(node) {
  if (node.type === 'SoftBreak' || node.type === 'LineBreak') return ' ';
  if (node.content !== undefined) return node.content;
  return node.children?.map(extractNodeText).join('') ?? '';
}

/** Extracts the filename from a URL path, without extension. */
export function filenameFromUrl(url) {
  try {
    const pathname = new URL(url, 'https://placeholder').pathname;
    const filename = pathname.split('/').pop() ?? '';
    return filename.replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

/**
 * Stamps each task ListItem with a sequential `taskIndex` matching the order
 * native C++ assigns — so onTaskListItemPress.index is correct on web too.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export function indexTaskItems(node, counter = {
  value: 0
}) {
  if (node.type === 'ListItem' && node.attributes?.isTask === 'true') {
    node.attributes.taskIndex = counter.value++;
  }
  node.children?.forEach(child => indexTaskItems(child, counter));
}

/**
 * Stamps Image nodes with `isInline` when they appear inside a paragraph
 * that also contains other content (text, links, etc.).
 * Matches native behavior: sole-child images are block-level, mixed are inline.
 * A link wrapping only an image counts as an image, so `[![badge](x)](y) text`
 * stamps the nested image inline while a lone `[![x](y)](z)` stays a block.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export function markInlineImages(node) {
  if (node.type === 'Paragraph' && node.children) {
    if (!node.children.every(isImageLike)) {
      node.children.forEach(stampInlineImages);
    }
  }
  node.children?.forEach(markInlineImages);
}
function isImageLike(node) {
  if (node.type === 'Image') return true;
  return node.type === 'Link' && node.children?.length === 1 && isImageLike(node.children[0]);
}
function stampInlineImages(node) {
  if (node.type === 'Image') {
    node.attributes = {
      ...node.attributes,
      isInline: true
    };
    return;
  }
  node.children?.forEach(stampInlineImages);
}
//# sourceMappingURL=utils.js.map
