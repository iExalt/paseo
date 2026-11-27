import type { ASTNode } from '../../types';
import { type BlockRange } from '../model/blocks';
import { type FormattingRange } from '../model/inlineStyles';
export interface ParseResult {
    plainText: string;
    formattingRanges: FormattingRange[];
    blockRanges: BlockRange[];
}
export declare function parseResultFromAst(ast: ASTNode): ParseResult;
export declare function parseToPlainTextAndRanges(markdown: string): Promise<ParseResult>;
//# sourceMappingURL=InputParser.d.ts.map