import type { ComponentType } from "react";
import { HighlightedCodeBlock, type CodeFindMatch } from "@/components/highlighted-code-block";
import { getDiagramFenceLanguage, type DiagramFenceLanguage } from "./diagram";
import { getMarkdownFenceLanguage } from "./language";
import { MermaidFence } from "./mermaid";
import type { MarkdownFenceRendererProps } from "./types";

export interface MarkdownFenceBlockProps extends MarkdownFenceRendererProps {
  info: string | null | undefined;
  /** Chat find's selected occurrence; diagrams render without it. */
  findMatch?: CodeFindMatch | null;
}

const diagramFences: Record<DiagramFenceLanguage, ComponentType<MarkdownFenceRendererProps>> = {
  mermaid: MermaidFence,
};

export function MarkdownFenceBlock({
  code,
  info,
  phase,
  inheritedStyles,
  textStyle,
  findMatch,
}: MarkdownFenceBlockProps) {
  const language = getMarkdownFenceLanguage(info);
  const diagram = getDiagramFenceLanguage(info);
  const DiagramFence = diagram ? diagramFences[diagram] : undefined;
  if (DiagramFence) {
    return (
      <DiagramFence
        code={code}
        phase={phase}
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    );
  }
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
      findMatch={findMatch}
    />
  );
}
