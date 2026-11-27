import type { StyleRun } from '../render/InputProjection';
import type { TextEdit } from '../model/textEdit';
export interface NativeEdit extends TextEdit {
    line: Element;
    span: Element;
    node: Text;
    nodeText: string;
}
export interface NativeEditContext {
    root: HTMLElement;
    isLine(node: Node): boolean;
    modelOffsetFromDom(node: Node, offset: number): number | null;
}
export declare function planNativeEdit(event: InputEvent, context: NativeEditContext): NativeEdit | null;
export declare function spansMatchRuns(edit: NativeEdit, runs: readonly StyleRun[], lineText: string): boolean;
export declare function nativeEditLanded(edit: NativeEdit, isLine: (node: Node) => boolean, runCount: number): boolean;
//# sourceMappingURL=NativeEdit.d.ts.map