import type { ASTNode } from "react-native-markdown-display";
import { getDiagramFenceLanguage } from "@/components/markdown/fence/diagram";

/**
 * The Markdown nodes whose text chat find numbers and marks. The pre-pass and the
 * assistant message rules both read this, so every counted occurrence can be drawn.
 */
export const FIND_MARKED_NODE_TYPES = new Set(["text", "code_inline", "code_block", "fence"]);

/** Diagrams draw no text to mark, so they hold no occurrences. */
export function isFindMarkedNode(node: Pick<ASTNode, "type" | "sourceInfo">): boolean {
  if (!FIND_MARKED_NODE_TYPES.has(node.type)) return false;
  return node.type !== "fence" || getDiagramFenceLanguage(node.sourceInfo) === null;
}
