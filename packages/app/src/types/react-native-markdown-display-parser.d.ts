// The parser on its own, without the package entry's JSX, so plain TypeScript and
// tests can run the exact parse the renderer runs. No top-level import or export,
// so this declares the module instead of augmenting one.
declare module "react-native-markdown-display/src/lib/parser" {
  import type { ASTNode, MarkdownParser } from "react-native-markdown-display";
  export default function parser<T>(
    source: string,
    renderer: (ast: ASTNode[]) => T,
    markdownIt: MarkdownParser,
  ): T;
}
