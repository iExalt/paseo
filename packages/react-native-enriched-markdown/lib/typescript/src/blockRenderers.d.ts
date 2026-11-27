import type { ReactNode } from 'react';
import type { MarkdownBlock, MarkdownRenderers } from './types/markdownBlocks';
/**
 * Runs the renderer for the block's kind and validates the result, the same
 * way on native and web. An element replaces the block; `undefined` keeps the
 * native block, and so do `null` and booleans from untyped callers. Strings and
 * numbers, alone or inside an array or fragment, are not valid children of a
 * native view, so they keep the native block too, with a dev warning; so does a
 * renderer that throws.
 */
export declare function renderBlock(renderers: MarkdownRenderers, block: MarkdownBlock): ReactNode | undefined;
/**
 * Whether any `renderers` entry is a function: `{}`, `undefined` entries and
 * unknown keys cost no parse. Shared by native, web and `useRenderedBlocks`.
 */
export declare function hasRenderers(renderers: MarkdownRenderers | undefined): boolean;
export interface RenderedBlock {
    block: MarkdownBlock;
    element: ReactNode;
}
/**
 * `renderBlock` over the blocks that a renderer replaces, in document order.
 * An unchanged block keeps its previous element, so React skips its subtree:
 * while streaming, the markdown changes every tick but the blocks already on
 * screen do not. New renderer functions render every block again.
 */
export declare function useRenderedBlocks(blocks: ReadonlyArray<MarkdownBlock>, renderers: MarkdownRenderers | undefined): ReadonlyArray<RenderedBlock>;
//# sourceMappingURL=blockRenderers.d.ts.map