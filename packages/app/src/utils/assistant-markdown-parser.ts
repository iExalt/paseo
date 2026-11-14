import type { MarkdownIt as MarkdownItType } from "markdown-it";
import { createMarkdownParser } from "@/utils/markdown-parser";

export function createAssistantMarkdownParser(): MarkdownItType {
  const parser = createMarkdownParser({ linkify: true });
  const defaultValidateLink = parser.validateLink.bind(parser);

  // Rich clipboard HTML preserves workspace file links.
  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  return parser;
}
