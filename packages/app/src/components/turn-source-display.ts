// A multiline input lays out its whole text at once; past this a long turn would stall
// the sheet, so it shows the start and Copy turn takes the rest.
export const TURN_SOURCE_DISPLAY_LIMIT = 50_000;

export function turnSourceDisplay(content: string): { text: string; truncated: boolean } {
  if (content.length <= TURN_SOURCE_DISPLAY_LIMIT) return { text: content, truncated: false };
  return { text: content.slice(0, TURN_SOURCE_DISPLAY_LIMIT), truncated: true };
}
