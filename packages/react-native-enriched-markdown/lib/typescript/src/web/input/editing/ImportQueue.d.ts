export declare class ImportQueue {
    private pending;
    afterImport<T>(task: () => T): T | Promise<T>;
    runAfterImport(task: () => void, onError: (error: unknown) => void): void;
    startImport(importTask: () => Promise<void> | void, onError: (error: unknown) => void): void;
}
//# sourceMappingURL=ImportQueue.d.ts.map