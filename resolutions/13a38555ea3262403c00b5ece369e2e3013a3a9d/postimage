import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useChatFindAnchorView } from "@/agent-stream/chat-find/anchor";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { density, resolveDensity } from "@/styles/density";
import { MarkdownBlockStack } from "./block-stack";
import { WEB_RENDERERS } from "./renderers";
import { createMarkdownStyles } from "./styles";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import { splitStreamingMarkdown } from "./streaming";
import { useMarkdownSource, type MarkdownImageContext } from "./images";

import { MermaidFence, MermaidStreamingContext, splitMermaidFences } from "./fence/mermaid";
import { FindCodeBlock } from "./find";
import { splitMarkdownForFind, type MarkdownFind } from "./find-split";

const ThemedMarkdown = withUnistyles(EnrichedMarkdownText);
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };
// Only a part carrying chat find's mark parses `==`; elsewhere it stays literal text.
const FIND_MD4C_FLAGS = { ...MD4C_FLAGS, highlight: true };

// Reading the breakpoint here makes Unistyles restyle the text when the layout crosses it.
const markdownStyle = (compact: boolean) => (theme: Theme, rt: { breakpoint?: string }) =>
  createMarkdownStyles(theme, { compact, blockGap: resolveDensity(rt, density.blockGap) });
const regularStyle = markdownStyle(false);
const compactStyle = markdownStyle(true);

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  onLinkPress?: (url: string) => unknown;
  /** Native chat find's selected occurrence; ignored while streaming. */
  find?: MarkdownFind | null;
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  const streaming = !isWeb && !!props.streaming;
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useMemo(
    () => splitStreamingMarkdown(completeLines, true).head.length,
    [completeLines],
  );
  if (props.find && !streaming) return <MarkdownFindParts {...props} find={props.find} />;
  if (!streaming || boundary === 0) return <MarkdownPart {...props} />;
  return (
    <MarkdownBlockStack>
      <MarkdownPart {...props} text={props.text.slice(0, boundary)} />
      <MarkdownPart {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

/**
 * Draws the block holding chat find's occurrence apart from the rest, so reveal can
 * measure it: Markdown with the occurrence highlighted, or a code block that marks it.
 */
function MarkdownFindParts({ find, ...props }: MarkdownRendererProps & { find: MarkdownFind }) {
  const split = useMemo(() => splitMarkdownForFind(props.text, find.match), [props.text, find]);
  // A code block measures the occurrence's own line; natively drawn Markdown cannot.
  const anchorRef = useChatFindAnchorView(split.code ? null : find.anchor, split.fraction);
  return (
    <MarkdownBlockStack>
      {split.head ? <MarkdownPart {...props} text={split.head} /> : null}
      <View ref={anchorRef} collapsable={false}>
        {split.code ? (
          <FindCodeBlock {...split.code} anchor={find.anchor} />
        ) : (
          <MarkdownPart {...props} text={split.block} highlight />
        )}
      </View>
      {split.tail ? <MarkdownPart {...props} text={split.tail} /> : null}
    </MarkdownBlockStack>
  );
}

const MarkdownPart = memo(function MarkdownPart({
  text,
  highlight = false,
  compact = false,
  streaming = false,
  onLinkPress,
  find: _find,
  ...imageContext
}: MarkdownRendererProps & { highlight?: boolean }) {
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const { markdown, imageSources, linkRecognition, linkSource } = useMarkdownSource(text, {
    workspaceRoot: environment.workspaceRoot,
    serverId: environment.serverId,
    ...imageContext,
    client,
  });
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url !== PENDING_MARKDOWN_IMAGE) setImage({ type: "uri", uri: url });
  });
  const closeImage = useStableEvent(() => setImage(null));
  const segments = useMemo(
    () =>
      isWeb ? [{ kind: "markdown", id: "0", source: markdown }] : splitMermaidFences(markdown),
    [markdown],
  );
  return (
    <MermaidStreamingContext.Provider value={streaming}>
      <MarkdownBlockStack imageSources={imageSources}>
        {segments.map((segment) =>
          segment.kind === "mermaid" ? (
            <MermaidFence key={`${segment.kind}:${segment.id}`} code={segment.source} />
          ) : (
            <ThemedMarkdown
              key={`${segment.kind}:${segment.id}`}
              markdown={segment.source}
              uniProps={compact ? compactStyle : regularStyle}
              flavor="github"
              selectable
              md4cFlags={highlight ? FIND_MD4C_FLAGS : MD4C_FLAGS}
              linkRecognition={linkRecognition}
              enableTaskListItemToggle={false}
              enableLinkPreview={false}
              enableBlockContextMenu={false}
              // JS reveal owns pacing; native fade animation is a separate experiment.
              streamingAnimation={false}
              onLinkPress={pressLink}
              onImagePress={pressImage}
              renderers={isWeb ? WEB_RENDERERS : undefined}
            />
          ),
        )}
      </MarkdownBlockStack>
      {image ? <AttachmentLightbox source={image} onClose={closeImage} /> : null}
    </MermaidStreamingContext.Provider>
  );
});
