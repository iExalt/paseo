import { getMarkdownFenceLanguage } from "./language";

/** Fence languages drawn as diagrams instead of code. */
export const DIAGRAM_FENCE_LANGUAGES = ["mermaid"] as const;
export type DiagramFenceLanguage = (typeof DIAGRAM_FENCE_LANGUAGES)[number];

export function getDiagramFenceLanguage(
  info: string | null | undefined,
): DiagramFenceLanguage | null {
  const language = getMarkdownFenceLanguage(info);
  return DIAGRAM_FENCE_LANGUAGES.find((diagram) => diagram === language) ?? null;
}
