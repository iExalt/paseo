import type { ASTNode } from './types';
/**
 * Whether `text` has a letter to resolve `dir="auto"` from. Chromium resolves
 * an element with none (digits, punctuation, empty) to LTR instead of
 * inheriting, so such elements must not get `dir="auto"`.
 */
export declare function hasStrongChar(text: string): boolean;
/**
 * `hasStrongChar` over the text a parent's `dir="auto"` reads: code blocks
 * carry their own `dir="ltr"` and an image's alt text is not content.
 */
export declare function hasStrongText(node: ASTNode): boolean;
/** Recursively collects plain text content from an AST node's subtree. */
export declare function extractNodeText(node: ASTNode): string;
/** Extracts the filename from a URL path, without extension. */
export declare function filenameFromUrl(url: string): string;
/**
 * Stamps each task ListItem with a sequential `taskIndex` matching the order
 * native C++ assigns — so onTaskListItemPress.index is correct on web too.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export declare function indexTaskItems(node: ASTNode, counter?: {
    value: number;
}): void;
/**
 * Stamps Image nodes with `isInline` when they appear inside a paragraph
 * that also contains other content (text, links, etc.).
 * Matches native behavior: sole-child images are block-level, mixed are inline.
 * A link wrapping only an image counts as an image, so `[![badge](x)](y) text`
 * stamps the nested image inline while a lone `[![x](y)](z)` stays a block.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export declare function markInlineImages(node: ASTNode): void;
//# sourceMappingURL=utils.d.ts.map