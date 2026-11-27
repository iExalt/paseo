export interface DomPosition {
    node: Node;
    offset: number;
}
export interface ModelSelectionPoints {
    anchor: number;
    focus: number;
}
export interface RenderedLines {
    readonly lineCount: number;
    lineStart(index: number): number;
    lineEnd(index: number): number;
    lineElement(index: number): HTMLElement | undefined;
    indexOfLine(node: Node): number;
}
export declare function isCaret(selection: Selection): boolean;
export declare class SelectionMapper {
    private readonly root;
    private readonly lines;
    constructor(root: HTMLElement, lines: RenderedLines);
    modelOffsetFromDom(node: Node, offset: number): number | null;
    domPositionFromModelOffset(offset: number): DomPosition | null;
    lineIndexAt(offset: number): number;
    modelSelectionFromDom(selection: Selection): ModelSelectionPoints | null;
    private offsetOfRootPoint;
    private lineContaining;
    private documentLength;
}
export declare function textLengthBefore(container: Node, node: Node, offset: number): number;
//# sourceMappingURL=SelectionMapper.d.ts.map