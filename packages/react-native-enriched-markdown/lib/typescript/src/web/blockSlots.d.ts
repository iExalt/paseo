import type { ASTNode } from './types';
import type { MarkdownBlock, MarkdownImageOccurrence, MarkdownLinkOccurrence } from '../types/markdownBlocks';
export interface CollectedBlocks {
    blocks: MarkdownBlock[];
    images: MarkdownImageOccurrence[];
    links: MarkdownLinkOccurrence[];
}
/** What an id hashes: the URL, text and title joined by U+001F, as in the core. */
export declare function blockIdentity(url: string, text?: string, title?: string): string;
/**
 * The web twin of `packages/core/cpp/parser/BlockSlots.cpp`: the same walk, the
 * same eligibility rule and the same ids (`<kind>:<hash>:<n>` for a block,
 * `img:<hash>:<n>` for an image occurrence, the hash over URL, text and title,
 * or over a code block's language alone),
 * so an app's renderer and resolver see identical ids on every platform. The
 * walk also stamps `blockSlotId` on every eligible block (the C++ core marks
 * only the active ones; on web the renderer result map decides) and
 * `imageOccurrenceId` on every image, which the renderers read.
 */
export declare function collectBlocks(root: ASTNode): CollectedBlocks;
/**
 * FNV-1a 64 over the UTF-8 bytes, as 16 lowercase hex digits. Four 16-bit
 * limbs instead of BigInt: the prime is 2^40 + 0x1b3, so each round is a few
 * small multiplications. Memoised, since a streaming document hashes the same
 * blocks on every tick.
 */
export declare function fnv1a64Hex(text: string): string;
//# sourceMappingURL=blockSlots.d.ts.map