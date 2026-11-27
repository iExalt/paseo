"use strict";

import { blockRenderers } from "./BlockRenderers.js";
import { inlineRenderers } from "./InlineRenderers.js";
import { listRenderers } from "./ListRenderers.js";
import { tableRenderers } from "./TableRenderers.js";
import { hasStrongText } from "../utils.js";

// Their `dir` would hide the cells' text from the table, so the cells resolve
// instead.
import { jsx as _jsx } from "react/jsx-runtime";
const TABLE_PARTS = new Set(['Table', 'TableHead', 'TableBody', 'TableRow']);

// A replaceable block keeps its identity across inserts above it, so the
// renderer's element (a playing video, a card's state) survives them.
function nodeKey(node, index) {
  const blockSlotId = node.attributes?.blockSlotId;
  if (blockSlotId !== undefined) return blockSlotId;
  if (node.type === 'ListItem' && node.attributes?.isTask === 'true') {
    const taskId = node.attributes.taskIndex ?? index;
    return `task-${taskId}-${node.attributes.taskChecked}`;
  }
  return index;
}
const RENDERERS = {
  ...blockRenderers,
  ...inlineRenderers,
  ...listRenderers,
  ...tableRenderers
};
export function RenderNode({
  node,
  style,
  styles,
  callbacks,
  capabilities,
  parentType,
  index
}) {
  const Renderer = RENDERERS[node.type];
  if (!Renderer) return null;

  // Only the outermost blocks get `dir`: a nested one would hide its text from
  // its parent's `dir="auto"` (e.g. `> > مرحبا` would put the outer border on
  // the left). A block with no letters inherits instead of turning LTR.
  const ownCapabilities = capabilities.blockDir && !hasStrongText(node) ? {
    ...capabilities,
    blockDir: undefined
  } : capabilities;
  const childCapabilities = ownCapabilities.blockDir && !TABLE_PARTS.has(node.type) ? {
    ...ownCapabilities,
    blockDir: undefined
  } : ownCapabilities;
  const renderChildren = childNode => childNode.children?.map((child, childIndex) => /*#__PURE__*/_jsx(RenderNode, {
    node: child,
    style: style,
    styles: styles,
    callbacks: callbacks,
    capabilities: childCapabilities,
    parentType: childNode.type,
    index: childIndex
  }, nodeKey(child, childIndex))) ?? null;
  return /*#__PURE__*/_jsx(Renderer, {
    node: node,
    style: style,
    styles: styles,
    parentType: parentType,
    index: index,
    callbacks: callbacks,
    capabilities: ownCapabilities,
    renderChildren: renderChildren
  });
}
//# sourceMappingURL=index.js.map
