import { type BlockRange } from '../model/blocks';
import type { FormattingRange } from '../model/inlineStyles';
export declare function serializeInline(text: string, ranges: readonly FormattingRange[]): string;
export declare function serialize(text: string, ranges: readonly FormattingRange[], blockRanges: readonly BlockRange[]): string;
export declare function markdownLinePrefix(block: BlockRange, parentContentColumn?: number): string;
//# sourceMappingURL=MarkdownSerializer.d.ts.map