import { useBackClosesFind } from "@/pane-find/use-back-closes-find";

/**
 * Android Back cancels an open review comment editor before it leaves the screen. The workspace
 * Back handler only runs on compact layouts, so on a tablet Back would otherwise exit the app.
 * `panelActive` keeps a retained hidden panel from swallowing Back.
 */
export function useBackCancelsReviewEditor(
  editorOpen: boolean,
  panelActive: boolean,
  cancel: () => void,
): void {
  useBackClosesFind(editorOpen && panelActive, cancel);
}
