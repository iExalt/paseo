import type { MarkdownLinkOccurrence } from './types/markdownBlocks';
export type LinksChangeHandler = (links: MarkdownLinkOccurrence[]) => void;
/**
 * Reports the collected links to `onLinksChange`, shared by the native and web
 * implementations. It runs in a layout effect, so a state update the handler
 * makes lands before the frame is drawn, and only when the links differ from
 * the last report: a streaming tick that adds no link reports nothing. The
 * handler is read like an event handler; a new function does not report again.
 * Nothing is reported while `collected` is false: the links are not known yet,
 * which is not the same as a document with none.
 */
export declare function useLinksChange(links: ReadonlyArray<MarkdownLinkOccurrence>, onLinksChange: LinksChangeHandler | undefined, collected: boolean): void;
//# sourceMappingURL=linkOccurrences.d.ts.map