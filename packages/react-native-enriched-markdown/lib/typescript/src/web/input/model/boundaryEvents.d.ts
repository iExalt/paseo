import type { InputStyleType } from './inlineStyles';
export interface BoundaryEvent {
    position: number;
    isOpening: boolean;
    type: InputStyleType;
    url: string | undefined;
}
export declare function compareBoundaryEvents(a: BoundaryEvent, b: BoundaryEvent, tieBreak?: (a: BoundaryEvent, b: BoundaryEvent) => number): number;
//# sourceMappingURL=boundaryEvents.d.ts.map