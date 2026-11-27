export declare function clamp(value: number, min: number, max: number): number;
export declare function firstIndexReachingTarget(target: number, size: number, valueAt: (index: number) => number): number;
export declare function isAsciiWhitespace(code: number): boolean;
export declare function lineStartsOf(text: string): number[];
export declare function lineEndOf(text: string, lineStarts: readonly number[]): (line: number) => number;
export declare function isWhitespace(char: string): boolean;
export declare function isLowSurrogate(code: number): boolean;
export declare function isCodePointBoundary(text: string, index: number): boolean;
export declare function codePointBoundaryAtOrBefore(text: string, index: number): number;
export declare function graphemeLengthBefore(text: string, position: number): number;
export declare function graphemeLengthAfter(text: string, position: number): number;
//# sourceMappingURL=utils.d.ts.map