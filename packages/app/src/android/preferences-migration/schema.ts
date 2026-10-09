import { z } from "zod";
import { Buffer } from "buffer";

const safeIdentifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const boundedPath = z.string().min(1).max(2048);

const AppPreferencesSchema = z.strictObject({
  theme: safeIdentifier,
  pluginThemeId: safeIdentifier.nullable(),
  language: z.enum(["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"]),
  sendBehavior: z.enum(["interrupt", "steer", "queue"]),
  serviceUrlBehavior: z.enum(["ask", "in-app", "external"]),
  terminalScrollbackLines: z.number().int().min(0).max(1_000_000),
  useLegacyTerminalRenderer: z.boolean(),
  uiFontFamily: z
    .string()
    .max(200)
    .refine((value) => !/https?:|\/\/|\b(token|password|secret)\b/i.test(value)),
  monoFontFamily: z
    .string()
    .max(200)
    .refine((value) => !/https?:|\/\/|\b(token|password|secret)\b/i.test(value)),
  uiBaseFontSize: z.number().min(10).max(21),
  contentFontSize: z.number().min(10).max(21),
  codeFontSize: z.number().min(9).max(22),
  contentMaxWidth: z.number().min(600).max(4000).nullable(),
  syntaxTheme: safeIdentifier,
  workspaceTitleSource: z.enum(["title", "branch"]),
  sidebarWorkspaceTrailing: z.enum(["diff", "timestamp", "none"]),
  sidebarRowItems: z.strictObject({
    branch: z.boolean(),
    project: z.boolean(),
    host: z.boolean(),
    changeRequest: z.boolean(),
    services: z.boolean(),
    labels: z.boolean(),
  }),
  sidebarChecksDisplay: z.enum(["iconAndText", "icon", "none"]),
  sidebarNavItems: z.array(z.strictObject({ key: safeIdentifier, visible: z.boolean() })).max(100),
  sidebarFooterItems: z
    .array(z.strictObject({ key: safeIdentifier, visible: z.boolean() }))
    .max(100),
  usage: z.strictObject({
    displayAs: z.enum(["used", "remaining"]),
    pins: z
      .array(z.strictObject({ sourceId: safeIdentifier, windowId: safeIdentifier }))
      .max(100)
      .nullable(),
    serverId: safeIdentifier.nullable(),
  }),
  autoExpandReasoning: z.boolean(),
  toolCallDetailLevel: z.enum(["overview", "detailed"]),
  chatOutlineEnabled: z.boolean(),
  vimKeybindings: z.boolean(),
  openInSidePane: z.strictObject({
    explorerFiles: z.boolean(),
    diffs: z.boolean(),
    chatFiles: z.boolean(),
    diffFiles: z.boolean(),
    subagents: z.boolean(),
  }),
  pullRequestOpenLocation: z.enum(["main", "side", "explorer"]),
});

const CreateAgentPreferencesSchema = z.strictObject({
  provider: safeIdentifier.optional(),
  providerPreferences: z
    .record(
      safeIdentifier,
      z.strictObject({
        model: safeIdentifier.optional(),
        mode: safeIdentifier.optional(),
        thinkingByModel: z.record(safeIdentifier, safeIdentifier).optional(),
      }),
    )
    .optional(),
  favoriteModels: z
    .array(z.strictObject({ provider: safeIdentifier, modelId: safeIdentifier }))
    .max(200)
    .optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
});

const ChangesPreferencesSchema = z.strictObject({
  layout: z.enum(["unified", "split"]).optional(),
  desktopTreeVisible: z.boolean().optional(),
  wrapLines: z.boolean().optional(),
  hideWhitespace: z.boolean().optional(),
  inlineDiff: z.boolean().optional(),
  commitsCollapsed: z.boolean().optional(),
});

const ShortcutOverridesSchema = z.record(
  safeIdentifier,
  z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9+\-_,. ]*$/)
    .nullable(),
);

const SafeTabTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("files") }),
  z.strictObject({ kind: z.literal("changes_tree") }),
  z.strictObject({ kind: z.literal("file"), path: boundedPath }),
]);
const SafeWorkspaceTabSchema = z.strictObject({
  tabId: safeIdentifier,
  target: SafeTabTargetSchema,
  createdAt: z.number().finite(),
});
const WorkspaceLayoutNodeSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("pane"),
      pane: z.strictObject({
        id: safeIdentifier,
        tabIds: z.array(safeIdentifier).max(40),
        focusedTabId: safeIdentifier.nullable(),
        hidden: z.boolean().optional(),
        tabs: z.array(SafeWorkspaceTabSchema).max(40),
      }),
    }),
    z.strictObject({
      kind: z.literal("group"),
      group: z.strictObject({
        id: safeIdentifier,
        direction: z.enum(["horizontal", "vertical"]),
        sizes: z.array(z.number().min(0).max(1)).max(20),
        children: z.array(WorkspaceLayoutNodeSchema).max(20),
      }),
    }),
  ]),
);
const WorkspaceLayoutPreferencesSchema = z.strictObject({
  // Geometry and selected file paths are user data and disclosed in the export UI.
  // Drafts, agent/session IDs, plugin state, and opaque tab state are excluded.
  root: WorkspaceLayoutNodeSchema,
  focusedPaneId: safeIdentifier.nullable(),
});

export const PreferencesTransferSchema = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  sourceLabel: z.string().min(1).max(80),
  daemonIds: z.array(safeIdentifier).max(100),
  app: AppPreferencesSchema,
  createAgent: CreateAgentPreferencesSchema,
  changes: ChangesPreferencesSchema,
  preferredEditor: safeIdentifier.nullable(),
  keyboardOverrides: ShortcutOverridesSchema,
  workspaceLayouts: z
    .record(z.string().min(1).max(512), WorkspaceLayoutPreferencesSchema)
    .optional(),
  sidebar: z
    .strictObject({
      groupMode: z.enum(["project", "status", "label"]).optional(),
      groupModeByServerId: z
        .record(safeIdentifier, z.enum(["project", "status", "label"]).optional())
        .optional(),
      hostFilters: z.array(safeIdentifier).max(100).optional(),
      projectFilters: z.array(z.string().max(512)).max(500).optional(),
      projectOrder: z.array(z.string().max(512)).max(500).optional(),
      projectOrderByServerId: z
        .record(safeIdentifier, z.array(z.string().max(512)).max(500))
        .optional(),
      pinnedWorkspaceOrder: z.array(z.string().max(512)).max(500).optional(),
      workspaceOrderByProject: z
        .record(z.string().max(512), z.array(z.string().max(512)).max(500))
        .optional(),
      serviceRouteByServerId: z
        .record(safeIdentifier, z.enum(["public", "paseo", "direct"]))
        .optional(),
      collapsed: z
        .strictObject({
          collapsedProjectKeys: z.array(z.string().max(512)).max(500).optional(),
          collapsedWorkspaceGroupKeys: z.array(safeIdentifier).max(100).optional(),
          collapsedStatusGroupKeys: z.array(safeIdentifier).max(100).optional(),
          collapsedPinned: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  panel: z
    .strictObject({
      mobileView: z.enum(["agent", "agent-list", "file-explorer"]).optional(),
      desktop: z
        .strictObject({
          agentListOpen: z.boolean().optional(),
          focusModeEnabled: z.boolean().optional(),
          zoomed: z.boolean().optional(),
          focused: z.boolean().optional(),
          fileExplorerOpen: z.boolean().optional(),
        })
        .optional(),
      explorerTab: z.enum(["changes", "files", "pr"]).optional(),
      sidebarWidth: z.number().min(200).max(600).optional(),
      treeRailWidth: z.number().min(180).max(600).optional(),
      explorerSortOption: z.enum(["name", "modified", "size"]).optional(),
      explorerShowHiddenFiles: z.boolean().optional(),
      expandedPathsByWorkspace: z
        .record(z.string().max(512), z.array(boundedPath).max(500))
        .optional(),
      collapsedFilePathsByWorkspace: z
        .record(z.string().max(512), z.array(boundedPath).max(500))
        .optional(),
    })
    .optional(),
  excluded: z
    .array(
      z.enum([
        "hostConnectionsAndPasswords",
        "clientIdentity",
        "pushSubscriptions",
        "draftsAndAttachments",
        "agentAndSessionState",
        "providerFeatureValues",
        "pluginState",
      ]),
    )
    .max(10),
});

export type PreferencesTransfer = z.infer<typeof PreferencesTransferSchema>;
export const MAX_PREFERENCES_TRANSFER_BYTES = 256 * 1024;

export function parsePreferencesTransfer(json: string): PreferencesTransfer {
  if (Buffer.byteLength(json, "utf8") > MAX_PREFERENCES_TRANSFER_BYTES) {
    throw new Error("Preferences file exceeds the 256 KiB limit.");
  }
  return PreferencesTransferSchema.parse(JSON.parse(json));
}
