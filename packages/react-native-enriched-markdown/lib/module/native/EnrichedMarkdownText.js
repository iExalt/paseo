"use strict";

import { useMemo, useCallback, useRef, useEffect } from 'react';
import EnrichedMarkdownTextNativeComponent from "../EnrichedMarkdownTextNativeComponent.js";
import EnrichedMarkdownNativeComponent from "../EnrichedMarkdownNativeComponent.js";
import { isLinkRecognitionEqual, toNativeLinkRecognition } from "../utils/regexParser.js";
import { normalizeMarkdownStyle } from '../normalizeMarkdownStyle';
import { isLinkPillContentEqual, normalizeLinkPillContent } from "../linkVariantUtils.js";
import { dispatchLinkContextMenuItem, isLinkContextMenuItemsEqual, normalizeLinkContextMenuItems } from "../linkContextMenuUtils.js";
import { resolveAccessibilityLabels } from "../accessibilityLabelDefaults.js";
import { NOT_COLLECTED, useBlockSlots, useCollectedMarkdown } from "./useBlockSlots.js";
import { hasRenderers } from "../blockRenderers.js";
import { useImageSources } from "./useImageSources.js";
import { useLinksChange } from "../linkOccurrences.js";
import { normalizeMenuItem, normalizeLegacyBooleanMenuItem } from "../normalizeMenuItem.js";
import { jsx as _jsx } from "react/jsx-runtime";
// Default English labels for the built-in selection menu actions. Defaults are
// resolved here (JS-side) so the native code always receives a concrete string.
const DEFAULT_COPY_LABEL = 'Copy';
const DEFAULT_COPY_AS_MARKDOWN_LABEL = 'Copy as Markdown';
const DEFAULT_COPY_IMAGE_URL_LABEL = 'Copy Image URL';
const DEFAULT_COPY_IMAGE_URLS_LABEL = 'Copy {count} Image URLs';

/**
 * Resolves `pluralLabels` into a per-count template table (index = image count,
 * 0..100) the native side can index without any locale logic. `Intl.PluralRules`
 * selects the CLDR category for each count; missing categories fall back to the
 * required `other`. Index 1 uses the singular `label` (the single-image case).
 * Native uses `other` (copyImageUrlsLabel) for counts > 100, and falls back to
 * the singular/`{count}` templates entirely when this returns an empty array
 * (no plural labels set, or `Intl.PluralRules` unavailable).
 */
const buildPluralTemplates = (pluralLabels, singularLabel) => {
  if (!pluralLabels) return [];
  const IntlRef = Intl;
  if (typeof IntlRef.PluralRules !== 'function') return [];
  let pluralRules;
  try {
    // TODO: expose `copyImageUrl.pluralLocale?: string` so i18n apps can force
    // a locale independent of the device. Today this resolves to the JS
    // runtime's default locale, so on an English device only `one` and `other`
    // ever fire even when richer plural labels are configured.
    pluralRules = new IntlRef.PluralRules();
  } catch {
    return [];
  }
  const {
    other
  } = pluralLabels;
  const byCategory = {
    zero: pluralLabels.zero ?? other,
    one: pluralLabels.one ?? other,
    two: pluralLabels.two ?? other,
    few: pluralLabels.few ?? other,
    many: pluralLabels.many ?? other,
    other
  };
  const templates = [];
  for (let n = 0; n <= 100; n++) {
    // The literal single-image case uses the (non-plural) singular label; every
    // other count uses its CLDR category form.
    templates.push(n === 1 ? singularLabel : byCategory[pluralRules.select(n)] ?? other);
  }
  return templates;
};
const NO_BLOCKS = [];
const defaultMd4cFlags = {
  underline: false,
  superscript: false,
  subscript: false,
  strikethrough: false,
  latexMath: true,
  highlight: false,
  hardSoftBreaks: false,
  preserveBlankLines: false,
  admonitions: true
};
export const EnrichedMarkdownText = ({
  markdown,
  markdownStyle = {},
  containerStyle,
  onLinkPress,
  onLinkLongPress,
  onImagePress,
  onTextPress,
  onTaskListItemPress,
  enableTaskListItemToggle = true,
  onCopyPress,
  onLatexError,
  onCodeBlockPress,
  enableCodeBlockWrapToggle = true,
  enableBlockContextMenu = true,
  enableLinkPreview,
  selectable = true,
  md4cFlags = defaultMd4cFlags,
  allowFontScaling = true,
  maxFontSizeMultiplier,
  allowTrailingMargin = false,
  flavor = 'commonmark',
  streamingAnimation = false,
  streamingConfig,
  spoilerOverlay = 'particles',
  contextMenuItems,
  linkContextMenuItems,
  imageRequestHeaders,
  renderers,
  resolveImageSource,
  onLinksChange,
  linkPillContent,
  linkRecognition,
  selectionMenuConfig,
  onSelectionCopy,
  accessibilityLabels,
  selectionColor,
  selectionHandleColor,
  textBreakStrategy,
  lineBreakStrategyIOS,
  writingDirection = 'first-strong',
  numberOfLines,
  ellipsizeMode,
  renderers: _renderers,
  ...rest
}) => {
  // An equal config keeps the previous object, so an inline literal does not
  // re-send the prop on every render.
  const linkRecognitionRef = useRef(undefined);
  const nativeLinkRecognition = useMemo(() => {
    const next = toNativeLinkRecognition(linkRecognition);
    if (!isLinkRecognitionEqual(linkRecognitionRef.current, next)) {
      linkRecognitionRef.current = next;
    }
    return linkRecognitionRef.current;
  }, [linkRecognition]);
  const normalizedStyleRef = useRef(null);
  const normalized = normalizeMarkdownStyle(markdownStyle);
  // normalizeMarkdownStyle returns cached objects for structurally equal inputs,
  // so this referential check is sufficient to preserve a stable prop reference.
  if (normalizedStyleRef.current !== normalized) {
    normalizedStyleRef.current = normalized;
  }
  const normalizedStyle = normalizedStyleRef.current;

  // Keyed on the flag values, not the object, so an inline `md4cFlags` literal
  // neither re-sends the prop nor re-parses for `renderers` on every render.
  const underline = md4cFlags.underline ?? false;
  const superscript = md4cFlags.superscript ?? false;
  const subscript = md4cFlags.subscript ?? false;
  const latexMath = md4cFlags.latexMath ?? true;
  const highlight = md4cFlags.highlight ?? false;
  const hardSoftBreaks = md4cFlags.hardSoftBreaks ?? false;
  const preserveBlankLines = md4cFlags.preserveBlankLines ?? false;
  // Admonitions are a GitHub-flavor feature; force them off in commonmark so
  // `> [!NOTE]` renders as a plain blockquote.
  const admonitions = flavor === 'github' ? md4cFlags.admonitions ?? true : false;
  // GitHub flavor always parses strikethrough, so the flag cannot change the
  // result there; force it off so toggling it does not invalidate anything.
  const strikethrough = flavor === 'github' ? false : md4cFlags.strikethrough ?? false;
  const normalizedMd4cFlags = useMemo(() => ({
    underline,
    superscript,
    subscript,
    strikethrough,
    latexMath,
    highlight,
    hardSoftBreaks,
    preserveBlankLines,
    admonitions
  }), [underline, superscript, subscript, strikethrough, latexMath, highlight, hardSoftBreaks, preserveBlankLines, admonitions]);
  const contextMenuCallbacksRef = useRef(new Map());
  useEffect(() => {
    const callbacksMap = new Map();
    if (contextMenuItems) {
      for (const item of contextMenuItems) {
        callbacksMap.set(item.text, item.onPress);
      }
    }
    contextMenuCallbacksRef.current = callbacksMap;
  }, [contextMenuItems]);
  const nativeContextMenuItems = useMemo(() => contextMenuItems?.filter(item => item.visible !== false).map(item => ({
    text: item.text,
    icon: item.icon
  })), [contextMenuItems]);
  const linkContextMenuItemsRef = useRef(linkContextMenuItems);
  linkContextMenuItemsRef.current = linkContextMenuItems;
  // Callbacks change on most renders; native only needs to hear about the menus
  // when what they show changes.
  const nativeLinkContextMenuItemsRef = useRef([]);
  const nativeLinkContextMenuItems = useMemo(() => {
    const next = normalizeLinkContextMenuItems(linkContextMenuItems);
    if (!isLinkContextMenuItemsEqual(nativeLinkContextMenuItemsRef.current, next)) {
      nativeLinkContextMenuItemsRef.current = next;
    }
    return nativeLinkContextMenuItemsRef.current;
  }, [linkContextMenuItems]);
  const handleLinkContextMenuItemPress = useCallback(event => {
    const {
      url,
      pattern,
      itemText
    } = event.nativeEvent;
    dispatchLinkContextMenuItem(linkContextMenuItemsRef.current, pattern, itemText, url);
  }, []);
  const nativeImageRequestHeaders = useMemo(() => imageRequestHeaders ? Object.entries(imageRequestHeaders).map(([name, value]) => ({
    name,
    value
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : undefined, [imageRequestHeaders]);

  // An equal map keeps the previous array, so passing the prop inline does not
  // re-send it to native on every render.
  const linkPillContentRef = useRef(undefined);
  const nativeLinkPillContent = useMemo(() => {
    const next = normalizeLinkPillContent(linkPillContent);
    if (!isLinkPillContentEqual(linkPillContentRef.current, next)) {
      linkPillContentRef.current = next;
    }
    return linkPillContentRef.current;
  }, [linkPillContent]);
  const handleContextMenuItemPress = useCallback(e => {
    const {
      itemText,
      selectedText,
      selectionStart,
      selectionEnd
    } = e.nativeEvent;
    const callback = contextMenuCallbacksRef.current.get(itemText);
    callback?.({
      text: selectedText,
      selection: {
        start: selectionStart,
        end: selectionEnd
      }
    });
  }, []);
  const handleLinkPress = useCallback(e => {
    const {
      url,
      sourceType
    } = e.nativeEvent;
    onLinkPress?.({
      url,
      sourceType: sourceType
    });
  }, [onLinkPress]);
  const handleLinkLongPress = useCallback(e => {
    const {
      url
    } = e.nativeEvent;
    onLinkLongPress?.({
      url
    });
  }, [onLinkLongPress]);
  const handleImagePress = useCallback(e => {
    const {
      url,
      altText
    } = e.nativeEvent;
    onImagePress?.({
      url,
      altText
    });
  }, [onImagePress]);
  const handleTextPress = useCallback(e => {
    const {
      index,
      text
    } = e.nativeEvent;
    onTextPress?.({
      index,
      text
    });
  }, [onTextPress]);
  const handleTaskListItemPress = useCallback(e => {
    const {
      index,
      checked,
      text
    } = e.nativeEvent;
    onTaskListItemPress?.({
      index,
      checked,
      text
    });
  }, [onTaskListItemPress]);
  const handleCopyPress = useCallback(e => {
    const {
      code,
      language
    } = e.nativeEvent;
    onCopyPress?.({
      code,
      language
    });
  }, [onCopyPress]);
  const handleLatexError = useCallback(e => {
    const {
      source,
      message,
      displayMode
    } = e.nativeEvent;
    onLatexError?.({
      source,
      message: message || undefined,
      displayMode
    });
  }, [onLatexError]);
  const handleCodeBlockPress = useCallback(e => {
    const {
      code,
      language
    } = e.nativeEvent;
    onCodeBlockPress?.({
      code,
      language
    });
  }, [onCodeBlockPress]);
  const handleSelectionCopy = useCallback(e => {
    const {
      text,
      format,
      selectionStart,
      selectionEnd
    } = e.nativeEvent;
    onSelectionCopy?.({
      text,
      format: format,
      selection: {
        start: selectionStart,
        end: selectionEnd
      }
    });
  }, [onSelectionCopy]);
  const tableMode = streamingConfig?.tableMode ?? 'progressive';
  const codeBlockMode = streamingConfig?.codeBlockMode ?? 'progressive';
  const mediaMode = streamingConfig?.mediaMode ?? 'progressive';
  const normalizedStreamingConfig = useMemo(() => ({
    tableMode,
    codeBlockMode,
    mediaMode
  }), [tableMode, codeBlockMode, mediaMode]);
  const normalizedSelectionMenuConfig = useMemo(() => {
    // The boolean acceptance is confined to this wrapper boundary via a single
    // `as unknown` cast; the public type only exposes the object shape.
    const config = selectionMenuConfig;
    const copy = normalizeMenuItem(config?.copy, true, DEFAULT_COPY_LABEL);
    const copyAsMarkdown = normalizeLegacyBooleanMenuItem(config?.copyAsMarkdown, 'selectionMenuConfig', 'copyAsMarkdown', true, DEFAULT_COPY_AS_MARKDOWN_LABEL);
    const copyImageUrl = normalizeLegacyBooleanMenuItem(config?.copyImageUrl, 'selectionMenuConfig', 'copyImageUrl', true, DEFAULT_COPY_IMAGE_URL_LABEL);
    const pluralLabels = config?.copyImageUrl?.pluralLabels;
    return {
      copyAsMarkdown: copyAsMarkdown.enabled,
      copyImageUrl: copyImageUrl.enabled,
      copyLabel: copy.label,
      copyAsMarkdownLabel: copyAsMarkdown.label,
      copyImageUrlLabel: copyImageUrl.label,
      copyImageUrlsLabel: pluralLabels?.other ?? DEFAULT_COPY_IMAGE_URLS_LABEL,
      copyImageUrlPluralTemplates: buildPluralTemplates(pluralLabels, copyImageUrl.label)
    };
  }, [selectionMenuConfig]);
  const resolvedAccessibilityLabels = useMemo(() => resolveAccessibilityLabels(accessibilityLabels), [accessibilityLabels]);

  // One parse on the JS thread serves both: the slot children land in the same
  // commit as the markdown they describe, the image sources before it is drawn.
  const isGFM = flavor === 'github';
  const renderersEnabled = hasRenderers(renderers);
  const collectEnabled = renderersEnabled || resolveImageSource != null || onLinksChange != null;
  const collectStreaming = useMemo(() => ({
    enabled: streamingAnimation,
    tableMode,
    codeBlockMode,
    mediaMode
  }), [streamingAnimation, tableMode, codeBlockMode, mediaMode]);
  const collected = useCollectedMarkdown(markdown, normalizedMd4cFlags, isGFM, collectEnabled, collectStreaming);
  const slotChildren = useBlockSlots(renderersEnabled ? collected.blocks : NO_BLOCKS, renderers);
  const imageSources = useImageSources(collected.images, resolveImageSource, resolveImageSource != null && isGFM);
  useLinksChange(collected.links, onLinksChange, collected !== NOT_COLLECTED);
  const sharedProps = {
    markdown,
    linkRecognition: nativeLinkRecognition,
    markdownStyle: normalizedStyle,
    onLinkPress: handleLinkPress,
    onLinkLongPress: handleLinkLongPress,
    onImagePress: handleImagePress,
    enableImagePress: onImagePress != null,
    onTextPress: handleTextPress,
    enableTextPress: onTextPress != null,
    onTaskListItemPress: handleTaskListItemPress,
    enableTaskListItemToggle,
    onCopyPress: handleCopyPress,
    onLatexError: handleLatexError,
    onCodeBlockPress: handleCodeBlockPress,
    enableCodeBlockPress: onCodeBlockPress != null,
    enableBlockContextMenu,
    enableLinkPreview: onLinkLongPress == null && (enableLinkPreview ?? true),
    selectable,
    md4cFlags: normalizedMd4cFlags,
    isGFM,
    allowFontScaling,
    maxFontSizeMultiplier,
    allowTrailingMargin,
    streamingAnimation,
    streamingConfig: normalizedStreamingConfig,
    spoilerOverlay,
    style: containerStyle,
    contextMenuItems: nativeContextMenuItems,
    linkContextMenuItems: nativeLinkContextMenuItems,
    onLinkContextMenuItemPress: handleLinkContextMenuItemPress,
    imageRequestHeaders: nativeImageRequestHeaders,
    linkPillContent: nativeLinkPillContent,
    selectionMenuConfig: normalizedSelectionMenuConfig,
    accessibilityLabels: resolvedAccessibilityLabels,
    onContextMenuItemPress: handleContextMenuItemPress,
    onSelectionCopy: handleSelectionCopy,
    selectionColor,
    selectionHandleColor,
    textBreakStrategy,
    lineBreakStrategyIOS,
    writingDirection,
    numberOfLines,
    ellipsizeMode,
    ...rest
  };
  if (isGFM) {
    return /*#__PURE__*/_jsx(EnrichedMarkdownNativeComponent, {
      ...sharedProps,
      enableCodeBlockWrapToggle: enableCodeBlockWrapToggle,
      imageSources: imageSources,
      children: slotChildren
    });
  }
  return /*#__PURE__*/_jsx(EnrichedMarkdownTextNativeComponent, {
    ...sharedProps
  });
};
export default EnrichedMarkdownText;
//# sourceMappingURL=EnrichedMarkdownText.js.map
