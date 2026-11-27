export type EditPhase = 'idle' | 'processing' | 'formatting' | 'importing';
export declare class EditSession {
    private composing;
    private currentPhase;
    get phase(): EditPhase;
    get isComposing(): boolean;
    beginComposition(): void;
    endComposition(): void;
    scoped<T>(phase: EditPhase, block: () => T): T;
    get shouldSuppressEvents(): boolean;
    get shouldSuppressSelectionSideEffects(): boolean;
}
//# sourceMappingURL=EditSession.d.ts.map