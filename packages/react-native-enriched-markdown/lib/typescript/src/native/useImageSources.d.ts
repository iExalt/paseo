import { type ImageSourceResolver } from '../imageSources';
import type { MarkdownImageOccurrence, MarkdownImageSource } from '../types/MarkdownTextProps';
/** One entry per image occurrence, as the native component takes it. */
export interface NativeImageSource {
    id: string;
    /** `""` keeps the placeholder and skips the request. */
    uri: string;
    headers: ReadonlyArray<{
        name: string;
        value: string;
    }>;
}
/**
 * The `imageSources` prop for the collected occurrences: resolved sources as
 * given, pending ones as empty uris, and no entry for images that keep their
 * Markdown URL. See `useResolvedImageSources` for the resolution rules.
 */
export declare function useImageSources(occurrences: ReadonlyArray<MarkdownImageOccurrence>, resolver: ImageSourceResolver | undefined, enabled: boolean): ReadonlyArray<NativeImageSource> | undefined;
export type { MarkdownImageSource };
//# sourceMappingURL=useImageSources.d.ts.map