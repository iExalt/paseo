import type { EnrichedMarkdownTextProps } from './types/MarkdownTextProps';
import type { MarkdownImageOccurrence, MarkdownImageSource } from './types/markdownBlocks';
export type ImageSourceResolver = NonNullable<EnrichedMarkdownTextProps['resolveImageSource']>;
/** What the resolver decided for one occurrence, so far. */
export type ResolvedImageSource = {
    state: 'pending';
} | {
    state: 'markdown';
} | {
    state: 'resolved';
    source: MarkdownImageSource;
};
/**
 * Runs `resolveImageSource` once per image while it stays in the document,
 * shared by the native and web implementations.
 *
 * The resolver runs after rendering (a layout effect), never during it, so a
 * render React throws away starts no request and a resolver may update other
 * state. Until it answers, the image is pending (the host shows the
 * placeholder and does not request the Markdown URL); a synchronous answer
 * lands before the frame is drawn.
 *
 * Answers are kept by occurrence id while the occurrence is unchanged, so a
 * streaming append or an edit elsewhere neither asks again nor drops an image
 * that already resolved; images that leave the document are forgotten. An
 * image that only moves to another placement (a paragraph streams on past it)
 * is asked again but keeps its answer until the new one lands. A
 * promise keeps its image pending until it settles; a rejection or a thrown
 * error logs in dev and keeps the placeholder. The resolver is read like an
 * event handler: changing the function does not run it again. Remount with a
 * `key` to resolve everything again.
 */
export declare function useResolvedImageSources(occurrences: ReadonlyArray<MarkdownImageOccurrence>, resolver: ImageSourceResolver | undefined, enabled: boolean): ReadonlyMap<string, ResolvedImageSource> | undefined;
//# sourceMappingURL=imageSources.d.ts.map