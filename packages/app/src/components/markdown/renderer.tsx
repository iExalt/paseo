import { memo, useMemo } from "react";
import { View } from "react-native";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { matchCommandLink, useAgentCommandHints, type CommandHints } from "@/agent-commands";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import { openExternalUrl } from "@/utils/open-external-url";
import { useChatFindAnchorView } from "@/agent-stream/chat-find/anchor";
import { useAttachmentLightbox } from "@/components/attachment-lightbox-context";
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
// A README is written for its forge, where the lines of a paragraph join into one.
const EXTERNAL_MD4C_FLAGS = { ...MD4C_FLAGS, hardSoftBreaks: false };
// Only a part carrying chat find's mark parses `==`; elsewhere it stays literal text.
const FIND_MD4C_FLAGS = { ...MD4C_FLAGS, highlight: true };
const EXTERNAL_FIND_MD4C_FLAGS = { ...EXTERNAL_MD4C_FLAGS, highlight: true };

// Reading the breakpoint here makes Unistyles restyle the text when the layout crosses it.
const markdownStyle =
  (compact: boolean, muted = false, imageMaxHeight?: number) =>
  (theme: Theme, rt: { breakpoint?: string }) =>
    createMarkdownStyles(theme, {
      compact,
      muted,
      blockGap: resolveDensity(rt, density.blockGap),
      imageMaxHeight,
    });
// A dialog shows several images at once, so each stays well under the chat's cap.
const DIALOG_IMAGE_MAX_HEIGHT = 240;
const regularStyle = markdownStyle(false);
const compactStyle = markdownStyle(true);
const compactMutedStyle = markdownStyle(true, true);
const dialogStyle = markdownStyle(true, false, DIALOG_IMAGE_MAX_HEIGHT);
const dialogMutedStyle = markdownStyle(true, true, DIALOG_IMAGE_MAX_HEIGHT);

function pickMarkdownStyle(compact: boolean, muted: boolean, dialog: boolean) {
  if (dialog) return muted ? dialogMutedStyle : dialogStyle;
  if (!compact) return regularStyle;
  return muted ? compactMutedStyle : compactStyle;
}

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  /** Muted text colour. Compact surfaces only. */
  muted?: boolean;
  /** Compact text with images capped for a dialog; implies compact. */
  dialog?: boolean;
  selectable?: boolean;
  streaming?: boolean;
  onLinkPress?: (url: string) => unknown;
  agentCommands?: boolean;
  /**
   * Author-controlled Markdown from outside this host, such as a plugin README: only its https
   * links and images work, nothing is read as a file, forge reference or command, and the lines of
   * a paragraph join as they do on its forge.
   */
  external?: boolean;
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
  const Part = props.agentCommands ? CommandMarkdownPart : MarkdownPart;
  if (props.find && !streaming) return <MarkdownFindParts {...props} find={props.find} />;
  if (!streaming || boundary === 0) return <Part {...props} />;
  return (
    <MarkdownBlockStack>
      <Part {...props} text={props.text.slice(0, boundary)} />
      <Part {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

const CommandMarkdownPart = memo(function CommandMarkdownPart(
  props: MarkdownRendererProps & { highlight?: boolean },
) {
  const commandHints = useAgentCommandHints();
  return <MarkdownPart {...props} commandHints={commandHints} />;
});
/**
 * Draws the block holding chat find's occurrence apart from the rest, so reveal can
 * measure it: Markdown with the occurrence highlighted, or a code block that marks it.
 */
function MarkdownFindParts({ find, ...props }: MarkdownRendererProps & { find: MarkdownFind }) {
  const Part = props.agentCommands ? CommandMarkdownPart : MarkdownPart;
  const split = useMemo(() => splitMarkdownForFind(props.text, find.match), [props.text, find]);
  // A code block measures the occurrence's own line; natively drawn Markdown cannot.
  const anchorRef = useChatFindAnchorView(split.code ? null : find.anchor, split.fraction);
  return (
    <MarkdownBlockStack>
      {split.head ? <Part {...props} text={split.head} /> : null}
      <View ref={anchorRef} collapsable={false}>
        {split.code ? (
          <FindCodeBlock {...split.code} anchor={find.anchor} compact={props.compact} />
        ) : (
          <Part {...props} text={split.block} highlight />
        )}
      </View>
      {split.tail ? <Part {...props} text={split.tail} /> : null}
    </MarkdownBlockStack>
  );
}

const MarkdownPart = memo(function MarkdownPart({
  text,
  highlight = false,
  compact = false,
  muted = false,
  dialog = false,
  selectable = true,
  streaming = false,
  onLinkPress,
  agentCommands: _agentCommands,
  external = false,
  commandHints = null,
  find: _find,
  ...imageContext
}: MarkdownRendererProps & { commandHints?: CommandHints | null; highlight?: boolean }) {
  let md4cFlags = highlight ? FIND_MD4C_FLAGS : MD4C_FLAGS;
  if (external) {
    md4cFlags = highlight ? EXTERNAL_FIND_MD4C_FLAGS : EXTERNAL_MD4C_FLAGS;
  }
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const workspaceForgeShorthand = useForgeShorthand();
  const forgeShorthand = external ? null : workspaceForgeShorthand;
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const { markdown, imageSources, imageAttachments, linkRecognition, linkSource } =
    useMarkdownSource(
      text,
      {
        workspaceRoot: environment.workspaceRoot,
        serverId: environment.serverId,
        ...imageContext,
        client,
      },
      {
        commandNames: commandHints?.names,
        forgeReferencePattern: forgeShorthand?.pattern,
        external,
      },
    );
  const { open: openLightbox, localLightbox } = useAttachmentLightbox();
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    if (external) {
      // The parser still autolinks bare http, www and email text; only https links open.
      const safe = pluginOverviewUrl(url);
      if (safe) void openExternalUrl(safe);
      return;
    }
    const command = commandHints && matchCommandLink(url, sourceType, commandHints.names);
    if (command) {
      commandHints.insert(command);
      return;
    }
    const forgeUrl = sourceType === "text" ? forgeShorthand?.resolve(url) : null;
    if (forgeUrl) {
      void openExternalUrl(forgeUrl);
      return;
    }
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url === PENDING_MARKDOWN_IMAGE) return;
    const attachment = imageAttachments[url];
    openLightbox(
      attachment ? { type: "attachment", metadata: attachment } : { type: "uri", uri: url },
    );
  });
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
              uniProps={pickMarkdownStyle(compact, muted, dialog)}
              flavor="github"
              selectable={selectable}
              md4cFlags={md4cFlags}
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
      {localLightbox}
    </MermaidStreamingContext.Provider>
  );
});
