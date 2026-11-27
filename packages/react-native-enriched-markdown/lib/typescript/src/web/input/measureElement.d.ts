import type { MeasureCallback, MeasureInWindowCallback, MeasureLayoutCallback } from '../../types/MarkdownTextInputInstance';
export declare function measure(element: HTMLElement, callback: MeasureCallback): void;
export declare function measureInWindow(element: HTMLElement, callback: MeasureInWindowCallback): void;
export declare function measureLayout(element: HTMLElement, relativeTo: number | Node, onSuccess: MeasureLayoutCallback, onFail?: () => void): void;
//# sourceMappingURL=measureElement.d.ts.map