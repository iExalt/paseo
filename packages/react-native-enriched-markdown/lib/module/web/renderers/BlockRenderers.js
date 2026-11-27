"use strict";

import { extractNodeText, filenameFromUrl } from "../utils.js";
import { toHeadingLevel } from "../styles.js";
import { KaTeXRenderer } from "./KaTeXRenderer.js";
import { ADMONITION_ICON_PATHS, ADMONITION_ICON_VIEWBOX, ADMONITION_TITLES } from "./admonitionIcons.js";
import { ENRM_ADMONITION_CLASS } from "../globalStyles.js";
import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
function ParagraphRenderer({
  node,
  styles,
  parentType,
  capabilities,
  renderChildren
}) {
  const isImageOnly = node.children?.length === 1 && node.children[0]?.type === 'Image';
  const inQuote = parentType === 'Blockquote' || parentType === 'Admonition';
  const slot = blockSlotFor(node, capabilities);
  if (slot !== undefined) {
    const spacing = isImageOnly ? styles.image : inQuote ? styles.paragraphInBlockquote : styles.paragraph;
    return /*#__PURE__*/_jsx("div", {
      style: slotSpacing(spacing),
      children: slot
    });
  }
  if (isImageOnly) return /*#__PURE__*/_jsx(_Fragment, {
    children: renderChildren(node)
  });
  if (inQuote) {
    return /*#__PURE__*/_jsx("p", {
      style: styles.paragraphInBlockquote,
      children: renderChildren(node)
    });
  }
  if (parentType === 'ListItem') {
    return /*#__PURE__*/_jsx("span", {
      children: renderChildren(node)
    });
  }
  return /*#__PURE__*/_jsx("p", {
    style: styles.paragraph,
    dir: capabilities.blockDir,
    children: renderChildren(node)
  });
}
function HeadingRenderer({
  node,
  styles,
  capabilities,
  renderChildren
}) {
  const Tag = toHeadingLevel(node.attributes?.level ?? '1');
  return /*#__PURE__*/_jsx(Tag, {
    style: styles[Tag],
    dir: capabilities.blockDir,
    children: renderChildren(node)
  });
}
function BlockquoteRenderer({
  node,
  styles,
  capabilities,
  renderChildren
}) {
  const CustomBlockquote = capabilities.webRenderers?.blockquote;
  if (CustomBlockquote) {
    return /*#__PURE__*/_jsx(CustomBlockquote, {
      blockquoteProps: {
        style: styles.blockquote,
        dir: capabilities.blockDir
      },
      children: renderChildren(node)
    });
  }
  return /*#__PURE__*/_jsx("blockquote", {
    style: styles.blockquote,
    dir: capabilities.blockDir,
    children: renderChildren(node)
  });
}
function AdmonitionRenderer({
  node,
  style,
  styles,
  capabilities,
  renderChildren
}) {
  const type = node.attributes?.admonitionType ?? 'note';
  const blockquote = style.blockquote;
  const colors = blockquote.admonitions[type] ?? blockquote.admonitions.note;
  const tint = colors.color;
  const iconSize = Math.ceil(blockquote.fontSize);
  // Reuse the blockquote box geometry; override the accent bar + fill per type.
  const boxStyle = {
    ...styles.blockquote,
    borderInlineStart: `${blockquote.borderWidth}px solid ${tint}`,
    backgroundColor: colors.backgroundColor
  };
  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: Math.round(iconSize * 0.4),
    marginBottom: Math.round(blockquote.fontSize * 0.4),
    color: tint,
    fontWeight: 'bold',
    fontSize: blockquote.fontSize,
    lineHeight: 1.2
  };
  // The data attributes let a copy serializer write `> [!TYPE]` instead of the title.
  return /*#__PURE__*/_jsxs("div", {
    className: ENRM_ADMONITION_CLASS,
    style: boxStyle,
    dir: capabilities.blockDir,
    "data-enrm-admonition-type": type,
    children: [/*#__PURE__*/_jsxs("div", {
      style: headerStyle,
      "data-enrm-admonition-title": "",
      children: [/*#__PURE__*/_jsx("svg", {
        width: iconSize,
        height: iconSize,
        viewBox: `0 0 ${ADMONITION_ICON_VIEWBOX} ${ADMONITION_ICON_VIEWBOX}`,
        fill: tint,
        "aria-hidden": "true",
        children: /*#__PURE__*/_jsx("path", {
          d: ADMONITION_ICON_PATHS[type]
        })
      }), /*#__PURE__*/_jsx("span", {
        dir: "ltr",
        children: ADMONITION_TITLES[type]
      })]
    }), renderChildren(node)]
  });
}
function CodeBlockRenderer({
  node,
  styles,
  renderChildren,
  callbacks,
  capabilities
}) {
  const slot = blockSlotFor(node, capabilities);
  if (slot !== undefined) {
    return /*#__PURE__*/_jsx("div", {
      style: slotSpacing(styles.codeBlock),
      children: slot
    });
  }
  const language = node.attributes?.language;
  const CustomCodeBlock = capabilities.webRenderers?.codeBlock;
  if (CustomCodeBlock) {
    // The custom renderer owns the block's look; the library keeps its spacing,
    // including the zeroed trailing margin of the last block.
    return /*#__PURE__*/_jsx("div", {
      style: {
        marginTop: styles.codeBlock.marginTop,
        marginBottom: styles.codeBlock.marginBottom
      },
      children: /*#__PURE__*/_jsx(CustomCodeBlock, {
        code: extractNodeText(node),
        language: language ?? ''
      })
    });
  }
  const label = language ? `Code block: ${language}` : 'Code block';
  if (callbacks.onCodeBlockPress == null) {
    return /*#__PURE__*/_jsx("pre", {
      style: styles.codeBlock,
      dir: "ltr",
      "aria-label": label,
      children: /*#__PURE__*/_jsx("code", {
        style: styles.codeBlockFont,
        children: renderChildren(node)
      })
    });
  }
  const press = () => callbacks.onCodeBlockPress?.({
    code: extractNodeText(node).replace(/\n+$/, ''),
    language: language ?? ''
  });

  // Don't fire while code text is selected - selection stays separate from the tap.
  const handleClick = () => {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    press();
  };
  const handleKeyDown = event => {
    if (event.repeat) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      press();
    }
  };
  return /*#__PURE__*/_jsx("pre", {
    style: {
      ...styles.codeBlock,
      cursor: 'pointer'
    },
    dir: "ltr",
    "aria-label": label,
    role: "button",
    tabIndex: 0,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    children: /*#__PURE__*/_jsx("code", {
      style: styles.codeBlockFont,
      children: renderChildren(node)
    })
  });
}
function ThematicBreakRenderer({
  styles
}) {
  return /*#__PURE__*/_jsx("hr", {
    style: styles.thematicBreak
  });
}

// Each blank line in the source becomes one empty line. Rendered as a spacer
// sized to the paragraph line height (rather than a run of <br>, whose height
// would follow the container line height) so the vertical rhythm matches the
// surrounding paragraphs. Any extra block spacing is left to the caller.
function BlankLineRenderer({
  node,
  style
}) {
  const count = Number.parseInt(node.attributes?.count ?? '0', 10);
  const lines = Number.isFinite(count) ? Math.max(0, count) : 0;
  if (lines === 0) return null;
  return /*#__PURE__*/_jsx("div", {
    "aria-hidden": "true",
    style: {
      height: lines * style.paragraph.lineHeight
    }
  });
}

// A replacement keeps the vertical spacing of the block it stands in for, as the
// native hosts give its placeholder the block's margins.
function slotSpacing(style) {
  return {
    marginTop: style.marginTop,
    marginBottom: style.marginBottom
  };
}

// A block slot the app filled, or undefined to keep the default rendering.
function blockSlotFor(node, capabilities) {
  const id = node.attributes?.blockSlotId;
  if (id === undefined) return undefined;
  return capabilities.blockSlots?.get(id);
}
function ImageRenderer({
  node,
  styles,
  parentType,
  callbacks,
  capabilities
}) {
  const url = node.attributes?.url;
  if (!url) return null;
  const occurrenceId = node.attributes?.imageOccurrenceId;
  const resolved = occurrenceId !== undefined && capabilities.imageSources?.has(occurrenceId) ? capabilities.imageSources.get(occurrenceId) : url;
  // A pending or failed resolution keeps the element, so layout holds, without a request.
  const src = resolved === null || resolved === '' ? undefined : resolved;
  const title = node.attributes?.title;
  const markdownAlt = extractNodeText(node).trim();
  const alt = markdownAlt || title || filenameFromUrl(url) || 'Image';
  const imgStyle = node.attributes?.isInline ? styles.inlineImage : styles.image;
  const interactive = callbacks.onImagePress != null && parentType !== 'Link' && parentType !== 'TableCell' && parentType !== 'TableHeaderCell';
  if (!interactive) {
    return /*#__PURE__*/_jsx("img", {
      src: src,
      alt: alt,
      title: title,
      style: imgStyle
    });
  }
  const press = () => callbacks.onImagePress?.({
    url,
    altText: markdownAlt
  });
  const handleKeyDown = event => {
    if (event.repeat) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      press();
    }
  };
  return /*#__PURE__*/_jsx("img", {
    src: src,
    alt: alt,
    title: title,
    style: {
      ...imgStyle,
      cursor: 'zoom-in'
    },
    role: "button",
    tabIndex: 0,
    "aria-label": alt,
    onClick: press,
    onKeyDown: handleKeyDown
  });
}
function LatexMathDisplayRenderer({
  node,
  styles,
  capabilities
}) {
  const content = extractNodeText(node);
  return /*#__PURE__*/_jsx(KaTeXRenderer, {
    content: content,
    katex: capabilities.katex,
    displayMode: true,
    style: styles.mathDisplay
  });
}
function VideoRenderer({
  node,
  styles,
  capabilities
}) {
  const slot = blockSlotFor(node, capabilities);
  if (slot !== undefined) {
    return /*#__PURE__*/_jsx("div", {
      style: slotSpacing(styles.video),
      children: slot
    });
  }
  const url = node.attributes?.url;
  if (!url) return null;
  const title = node.attributes?.title;
  const alt = extractNodeText(node).trim();
  const label = alt || title || 'Video';
  return /*#__PURE__*/_jsx("video", {
    controls: true,
    playsInline: true,
    preload: "metadata",
    style: styles.video,
    title: title,
    "aria-label": label,
    children: /*#__PURE__*/_jsx("source", {
      src: url
    })
  });
}
export const blockRenderers = {
  Paragraph: ParagraphRenderer,
  Heading: HeadingRenderer,
  Blockquote: BlockquoteRenderer,
  Admonition: AdmonitionRenderer,
  CodeBlock: CodeBlockRenderer,
  ThematicBreak: ThematicBreakRenderer,
  BlankLine: BlankLineRenderer,
  Image: ImageRenderer,
  LatexMathDisplay: LatexMathDisplayRenderer,
  Video: VideoRenderer
};
//# sourceMappingURL=BlockRenderers.js.map
