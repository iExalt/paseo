import type { ASTNode } from './types';
import type { Md4cFlags } from '../types/MarkdownStyle';
/**
 * Parser options accepted by the web bridge: the public {@link Md4cFlags} plus
 * the flags the WASM parser understands but the component API does not expose.
 *
 * `permissiveAutolinks` has to stay settable because the two web call sites
 * want opposite values. The display component omits it and relies on the
 * `true` default, which is what renders bare URLs as links and matches the
 * native parsers, where the flag defaults on at every layer. The input editor
 * forces it off so its own autolink layer owns bare URLs. It is kept off
 * `Md4cFlags` rather than exposed because a public prop would be silently
 * ignored on iOS and Android, neither of which forwards it to its parser.
 */
export type WebMd4cFlags = Md4cFlags & {
    /**
     * Autolink bare URLs and e-mail addresses without angle brackets.
     * When disabled, only explicit `[text](url)` and `<url>` links are parsed.
     * @default true
     */
    permissiveAutolinks?: boolean;
};
/** Starts the WASM load, or retries one that failed. */
export declare function loadParser(): Promise<void>;
/** Whether {@link parseMarkdownSync} can run. */
export declare function isParserReady(): boolean;
/** Calls `listener` once the WASM load finishes. */
export declare function subscribeParserReady(listener: () => void): () => void;
export declare function preloadParser(): Promise<void>;
export declare function parseMarkdown(markdown: string, flags?: WebMd4cFlags): Promise<ASTNode>;
/**
 * Parses without waiting, for callers that render the result in the same
 * pass. Throws when the WASM has not loaded yet: check {@link isParserReady}.
 */
export declare function parseMarkdownSync(markdown: string, flags?: WebMd4cFlags): ASTNode;
//# sourceMappingURL=parseMarkdown.d.ts.map