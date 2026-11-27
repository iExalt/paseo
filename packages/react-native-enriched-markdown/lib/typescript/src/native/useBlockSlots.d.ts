import type { ReactNode } from 'react';
import { type NativeMd4cFlags, type NativeStreamingOptions } from '../NativeEnrichedMarkdownParser';
import type { MarkdownBlock, MarkdownImageOccurrence, MarkdownLinkOccurrence, MarkdownRenderers } from '../types/MarkdownTextProps';
export interface CollectedMarkdown {
    blocks: ReadonlyArray<MarkdownBlock>;
    images: ReadonlyArray<MarkdownImageOccurrence>;
    links: ReadonlyArray<MarkdownLinkOccurrence>;
}
export declare const NOT_COLLECTED: CollectedMarkdown;
/**
 * The blocks `renderers` may replace, the image occurrences
 * `resolveImageSource` is asked about and the links `onLinksChange` reports,
 * in document order, from one parse by
 * the C++ core. While streaming, the core applies the host's streaming filter
 * first, so nothing is collected for a block the host is not rendering yet.
 * Empty when disabled, when the module is unavailable (old architecture, web,
 * Jest) or when the flavor is not GitHub, where the native hosts place no slots.
 */
export declare function useCollectedMarkdown(markdown: string, flags: NativeMd4cFlags, isGFM: boolean, enabled: boolean, streaming: NativeStreamingOptions): CollectedMarkdown;
/**
 * Runs `renderers` over the collected blocks and wraps every element they return
 * in a slot child keyed by the block id. Unchanged blocks keep their element, so
 * keep the renderer functions stable (`useCallback`): a new function renders
 * every block again.
 */
export declare function useBlockSlots(blocks: ReadonlyArray<MarkdownBlock>, renderers: MarkdownRenderers | undefined): ReactNode[] | null;
//# sourceMappingURL=useBlockSlots.d.ts.map