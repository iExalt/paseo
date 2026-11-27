export interface KaTeXInstance {
    renderToString(expression: string, options?: {
        displayMode?: boolean;
        throwOnError?: boolean;
        trust?: boolean;
        output?: 'html' | 'mathml' | 'htmlAndMathml';
    }): string;
}
/** Lazily loads KaTeX. Returns null if not installed. */
export declare function loadKaTeX(): KaTeXInstance | null;
//# sourceMappingURL=katex.d.ts.map