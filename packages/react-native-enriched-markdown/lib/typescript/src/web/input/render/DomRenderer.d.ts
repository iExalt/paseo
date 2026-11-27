import { type Projection, type StyleRun } from './InputProjection';
export declare class DomRenderer {
    private readonly root;
    private renderedParagraphs;
    private renderedLineStarts;
    private lines;
    private lineIndices;
    private readonly dirtyLines;
    constructor(root: HTMLElement);
    get hasDirtyLines(): boolean;
    get lineCount(): number;
    lineStart(index: number): number;
    lineEnd(index: number): number;
    lineElement(index: number): HTMLElement | undefined;
    indexOfLine(node: Node): number;
    markLinesDirty(from: number, to: number): void;
    invalidate(): void;
    render(projection: Projection): void;
    private patch;
    private renumberAfter;
    private linesIntact;
}
export declare function classNameFor(styles: StyleRun['styles']): string;
export declare function isReusableRun(node: Node): boolean;
//# sourceMappingURL=DomRenderer.d.ts.map