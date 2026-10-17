// The runtime sets `sourceInfo` on fence/code nodes (tokensToAST.js sets
// `sourceInfo: token.info`) and `block` on every node, but the shipped .d.ts omits
// both. The re-export is what marks this file as a module so the `declare module`
// below augments the package instead of shadowing it.
export type { ASTNode } from "react-native-markdown-display";

declare module "react-native-markdown-display" {
  interface ASTNode {
    sourceInfo?: string;
    block?: boolean;
  }
}
