import { APP_SETTINGS_KEY } from "@/hooks/use-settings/keys";
import { Buffer } from "buffer";
import { normalizeAppSettings } from "@/hooks/use-settings/storage";
import {
  MAX_PREFERENCES_TRANSFER_BYTES,
  parsePreferencesTransfer,
  PreferencesTransferSchema,
  type PreferencesTransfer,
} from "./schema";
import { PREFERENCE_MIGRATION_KEYS, type PreferenceStorage } from "./journal";

const KEYS = {
  app: APP_SETTINGS_KEY,
  defaults: "@paseo:create-agent-preferences",
  changes: "@paseo:changes-preferences",
  editor: "@paseo:preferred-editor",
  shortcuts: "@paseo:keyboard-shortcut-overrides",
  sidebar: "sidebar-view",
  order: "sidebar-project-workspace-order",
  collapsed: "sidebar-collapsed-sections",
  panel: "panel-state",
  layout: "workspace-layout-state",
  routes: "workspace-service-route-preferences",
} as const;

export type TransferSection =
  | "appearance"
  | "defaults"
  | "changes"
  | "editor"
  | "shortcuts"
  | "sidebar"
  | "panel"
  | "workspace";

function parseObject(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function persistedState(value: string | null): Record<string, unknown> {
  const object = parseObject(value);
  return object.state !== null && typeof object.state === "object" && !Array.isArray(object.state)
    ? (object.state as Record<string, unknown>)
    : object;
}

function daemonScopedEntries<Value>(
  value: unknown,
  daemonIds: ReadonlySet<string>,
): Record<string, Value> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id]) => daemonIds.has(id))) as Record<
    string,
    Value
  >;
}

function workspaceScopedEntries<Value>(
  value: unknown,
  daemonIds: ReadonlySet<string>,
): Record<string, Value> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => {
      const separator = key.indexOf(":");
      return separator > 0 && daemonIds.has(key.slice(0, separator));
    }),
  ) as Record<string, Value>;
}

function keyBelongsToDaemon(key: string, daemonIds: ReadonlySet<string>): boolean {
  for (const daemonId of daemonIds) {
    if (
      key.startsWith(`${daemonId}:`) ||
      key.startsWith(`${daemonId}::`) ||
      key.startsWith(`host:${daemonId}:`) ||
      key.startsWith(`view:${daemonId}:`)
    )
      return true;
  }
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && daemonIds.has(parsed[0]);
  } catch {
    return false;
  }
}

function daemonScopedArray(value: unknown, daemonIds: ReadonlySet<string>): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && keyBelongsToDaemon(item, daemonIds),
      )
    : [];
}

function mergePlainIdArray(
  current: unknown,
  source: readonly string[],
  matchedIds: ReadonlySet<string>,
): string[] {
  const existing = Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
  return [
    ...new Set([
      ...existing.filter((id) => !matchedIds.has(id)),
      ...source.filter((id) => matchedIds.has(id)),
    ]),
  ];
}

function mergeDaemonMap<Value>(
  current: unknown,
  source: Record<string, Value>,
  matchedIds: ReadonlySet<string>,
): Record<string, Value> {
  const merged =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, Value>) }
      : {};
  for (const id of matchedIds) delete merged[id];
  return {
    ...merged,
    ...Object.fromEntries(Object.entries(source).filter(([id]) => matchedIds.has(id))),
  };
}

function mergeDaemonArray(
  current: unknown,
  source: readonly string[],
  matchedIds: ReadonlySet<string>,
): string[] {
  const existing = Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
  const preserved = existing.filter((item) => !keyBelongsToDaemon(item, matchedIds));
  const incoming = source.filter((item) => keyBelongsToDaemon(item, matchedIds));
  return [...new Set([...preserved, ...incoming])];
}

function mergeWorkspaceMap<Value>(
  current: unknown,
  source: Record<string, Value>,
  matchedIds: ReadonlySet<string>,
): Record<string, Value> {
  const merged =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, Value>) }
      : {};
  for (const key of Object.keys(merged)) {
    if (keyBelongsToDaemon(key, matchedIds)) delete merged[key];
  }
  return { ...merged, ...workspaceScopedEntries(source, matchedIds) };
}

function safeWorkspaceNode(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane" && node.pane && typeof node.pane === "object") {
    const pane = node.pane as Record<string, unknown>;
    const tabs = Array.isArray(pane.tabs) ? pane.tabs : [];
    const safeTabs = tabs.flatMap((tab) => {
      if (!tab || typeof tab !== "object") return [];
      const tabRecord = tab as Record<string, unknown>;
      const target = tabRecord.target;
      const tabId = tabRecord.tabId;
      const createdAt = tabRecord.createdAt;
      if (
        !target ||
        typeof target !== "object" ||
        typeof tabId !== "string" ||
        typeof createdAt !== "number"
      )
        return [];
      const candidate = target as Record<string, unknown>;
      if (candidate.kind === "files" || candidate.kind === "changes_tree") {
        return [{ tabId, createdAt, target: { kind: candidate.kind } }];
      }
      if (candidate.kind === "file" && typeof candidate.path === "string") {
        return [{ tabId, createdAt, target: { kind: "file", path: candidate.path } }];
      }
      return [];
    });
    return {
      kind: "pane",
      pane: {
        id: pane.id,
        tabIds: safeTabs.map(({ tabId }) => tabId),
        focusedTabId: safeTabs.some(({ tabId }) => tabId === pane.focusedTabId)
          ? pane.focusedTabId
          : null,
        ...(typeof pane.hidden === "boolean" ? { hidden: pane.hidden } : {}),
        tabs: safeTabs,
      },
    };
  }
  if (node.kind === "group" && node.group && typeof node.group === "object") {
    const group = node.group as Record<string, unknown>;
    return {
      kind: "group",
      group: {
        id: group.id,
        direction: group.direction,
        sizes: group.sizes,
        children: Array.isArray(group.children) ? group.children.map(safeWorkspaceNode) : [],
      },
    };
  }
  return null;
}

function projectAppPreferences(rawApp: string | null, daemonIds: ReadonlySet<string>) {
  const normalized = normalizeAppSettings(parseObject(rawApp));
  return {
    theme: normalized.theme,
    pluginThemeId: normalized.pluginThemeId,
    language: normalized.language,
    sendBehavior: normalized.sendBehavior,
    serviceUrlBehavior: normalized.serviceUrlBehavior,
    terminalScrollbackLines: normalized.terminalScrollbackLines,
    useLegacyTerminalRenderer: normalized.useLegacyTerminalRenderer,
    uiFontFamily: normalized.uiFontFamily,
    monoFontFamily: normalized.monoFontFamily,
    uiBaseFontSize: normalized.uiBaseFontSize,
    contentFontSize: normalized.contentFontSize,
    codeFontSize: normalized.codeFontSize,
    contentMaxWidth: normalized.contentMaxWidth,
    syntaxTheme: normalized.syntaxTheme,
    workspaceTitleSource: normalized.workspaceTitleSource,
    sidebarWorkspaceTrailing: normalized.sidebarWorkspaceTrailing,
    sidebarRowItems: normalized.sidebarRowItems,
    sidebarChecksDisplay: normalized.sidebarChecksDisplay,
    sidebarNavItems: normalized.sidebarNavItems,
    sidebarFooterItems: normalized.sidebarFooterItems,
    usage: {
      displayAs: normalized.usage.displayAs,
      pins: normalized.usage.pins,
      serverId:
        normalized.usage.serverId && daemonIds.has(normalized.usage.serverId)
          ? normalized.usage.serverId
          : null,
    },
    autoExpandReasoning: normalized.autoExpandReasoning,
    toolCallDetailLevel: normalized.toolCallDetailLevel,
    chatOutlineEnabled: normalized.chatOutlineEnabled,
    vimKeybindings: normalized.vimKeybindings,
    openInSidePane: normalized.openInSidePane,
    pullRequestOpenLocation: normalized.pullRequestOpenLocation,
  };
}

function projectCreateAgentPreferences(rawDefaults: string | null) {
  const defaults = parseObject(rawDefaults);
  const rawPreferences = defaults.providerPreferences;
  const providerPreferences = Object.fromEntries(
    Object.entries(
      rawPreferences && typeof rawPreferences === "object" && !Array.isArray(rawPreferences)
        ? (rawPreferences as Record<string, unknown>)
        : {},
    ).flatMap(([provider, value]) => {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(provider)) return [];
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const preferences = value as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      if (
        typeof preferences.model === "string" &&
        /^[A-Za-z0-9._:-]{1,160}$/.test(preferences.model)
      ) {
        safe.model = preferences.model;
      }
      if (
        typeof preferences.mode === "string" &&
        /^[A-Za-z0-9._:-]{1,160}$/.test(preferences.mode)
      ) {
        safe.mode = preferences.mode;
      }
      if (
        preferences.thinkingByModel &&
        typeof preferences.thinkingByModel === "object" &&
        !Array.isArray(preferences.thinkingByModel)
      ) {
        safe.thinkingByModel = Object.fromEntries(
          Object.entries(preferences.thinkingByModel).filter(
            ([model, option]) =>
              /^[A-Za-z0-9._:-]{1,160}$/.test(model) &&
              typeof option === "string" &&
              /^[A-Za-z0-9._:-]{1,160}$/.test(option),
          ),
        );
      }
      return [[provider, safe]];
    }),
  );
  const favoriteModels = Array.isArray(defaults.favoriteModels)
    ? defaults.favoriteModels.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const favorite = value as Record<string, unknown>;
        return typeof favorite.provider === "string" &&
          typeof favorite.modelId === "string" &&
          /^[A-Za-z0-9._:-]{1,160}$/.test(favorite.provider) &&
          /^[A-Za-z0-9._:-]{1,160}$/.test(favorite.modelId)
          ? [{ provider: favorite.provider, modelId: favorite.modelId }]
          : [];
      })
    : undefined;
  return {
    ...(typeof defaults.provider === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(defaults.provider)
      ? { provider: defaults.provider }
      : {}),
    ...(Object.keys(providerPreferences).length ? { providerPreferences } : {}),
    ...(favoriteModels ? { favoriteModels } : {}),
    ...(defaults.isolation === "local" || defaults.isolation === "worktree"
      ? { isolation: defaults.isolation }
      : {}),
  };
}

function projectChangesPreferences(rawChanges: string | null) {
  const changes = parseObject(rawChanges);
  return Object.fromEntries(
    [
      "layout",
      "desktopTreeVisible",
      "wrapLines",
      "hideWhitespace",
      "inlineDiff",
      "commitsCollapsed",
    ]
      .filter((key) => key in changes)
      .map((key) => [key, changes[key]]),
  );
}

function projectKeyboardOverrides(rawShortcuts: string | null) {
  return Object.fromEntries(
    Object.entries(parseObject(rawShortcuts)).filter(
      ([key, value]) =>
        /^[A-Za-z0-9._:-]{1,160}$/.test(key) &&
        (value === null ||
          (typeof value === "string" && /^[A-Za-z0-9+\-_,. ]{0,100}$/.test(value))),
    ),
  );
}

function projectWorkspaceLayouts(rawLayout: string | null, daemonIds: ReadonlySet<string>) {
  const layoutState = persistedState(rawLayout);
  const result: Record<string, unknown> = {};
  const source = layoutState.layoutByWorkspace;
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;
  for (const [workspaceKey, rawLayoutValue] of Object.entries(source)) {
    const separator = workspaceKey.indexOf(":");
    if (separator <= 0 || !daemonIds.has(workspaceKey.slice(0, separator))) continue;
    if (!rawLayoutValue || typeof rawLayoutValue !== "object") continue;
    const layout = rawLayoutValue as Record<string, unknown>;
    const root = safeWorkspaceNode(layout.root);
    if (root) result[workspaceKey] = { root, focusedPaneId: layout.focusedPaneId ?? null };
  }
  return result;
}

function projectSidebarPreferences(input: {
  rawSidebar: string | null;
  rawOrder: string | null;
  rawCollapsed: string | null;
  rawRoutes: string | null;
  daemonIds: ReadonlySet<string>;
}) {
  const state = persistedState(input.rawSidebar);
  const order = persistedState(input.rawOrder);
  const collapsed = persistedState(input.rawCollapsed);
  const routes = persistedState(input.rawRoutes);
  return {
    ...(state.groupMode ? { groupMode: state.groupMode } : {}),
    groupModeByServerId: daemonScopedEntries(state.groupModeByServerId, input.daemonIds),
    hostFilters: Array.isArray(state.hostFilters)
      ? state.hostFilters.filter(
          (id): id is string => typeof id === "string" && input.daemonIds.has(id),
        )
      : [],
    projectFilters: daemonScopedArray(state.projectFilters, input.daemonIds),
    projectOrder: daemonScopedArray(order.projectOrder, input.daemonIds),
    projectOrderByServerId: daemonScopedEntries(order.projectOrderByServerId, input.daemonIds),
    pinnedWorkspaceOrder: daemonScopedArray(order.pinnedWorkspaceOrder, input.daemonIds),
    workspaceOrderByProject: Object.fromEntries(
      Object.entries(order.workspaceOrderByProject ?? {}).filter(([key]) =>
        keyBelongsToDaemon(key, input.daemonIds),
      ),
    ),
    serviceRouteByServerId: daemonScopedEntries(routes.byServerId, input.daemonIds),
    collapsed: {
      collapsedProjectKeys: daemonScopedArray(collapsed.collapsedProjectKeys, input.daemonIds),
      collapsedWorkspaceGroupKeys: Array.isArray(collapsed.collapsedWorkspaceGroupKeys)
        ? collapsed.collapsedWorkspaceGroupKeys.filter(
            (key): key is string => typeof key === "string",
          )
        : [],
      collapsedStatusGroupKeys: Array.isArray(collapsed.collapsedStatusGroupKeys)
        ? collapsed.collapsedStatusGroupKeys.filter((key): key is string => typeof key === "string")
        : [],
      collapsedPinned: collapsed.collapsedPinned === true,
    },
  };
}

function projectPanelPreferences(rawPanel: string | null, daemonIds: ReadonlySet<string>) {
  const panel = persistedState(rawPanel);
  const desktop =
    panel.desktop && typeof panel.desktop === "object"
      ? (panel.desktop as Record<string, unknown>)
      : {};
  return {
    ...(panel.mobileView ? { mobileView: panel.mobileView } : {}),
    ...(Object.keys(desktop).length
      ? {
          desktop: {
            ...(typeof desktop.agentListOpen === "boolean"
              ? { agentListOpen: desktop.agentListOpen }
              : {}),
            ...(typeof desktop.focusModeEnabled === "boolean"
              ? { focusModeEnabled: desktop.focusModeEnabled }
              : {}),
            ...(typeof desktop.zoomed === "boolean" ? { zoomed: desktop.zoomed } : {}),
            ...(typeof desktop.focused === "boolean" ? { focused: desktop.focused } : {}),
            ...(typeof desktop.fileExplorerOpen === "boolean"
              ? { fileExplorerOpen: desktop.fileExplorerOpen }
              : {}),
          },
        }
      : {}),
    ...(panel.explorerTab ? { explorerTab: panel.explorerTab } : {}),
    ...(panel.sidebarWidth !== undefined ? { sidebarWidth: panel.sidebarWidth } : {}),
    ...(panel.treeRailWidth !== undefined ? { treeRailWidth: panel.treeRailWidth } : {}),
    ...(panel.explorerSortOption ? { explorerSortOption: panel.explorerSortOption } : {}),
    ...(panel.explorerShowHiddenFiles !== undefined
      ? { explorerShowHiddenFiles: panel.explorerShowHiddenFiles }
      : {}),
    expandedPathsByWorkspace: workspaceScopedEntries(panel.expandedPathsByWorkspace, daemonIds),
    collapsedFilePathsByWorkspace: workspaceScopedEntries(
      panel.collapsedFilePathsByWorkspace,
      daemonIds,
    ),
  };
}

export async function createPreferencesTransfer(input: {
  storage: PreferenceStorage;
  configuredDaemonIds: readonly string[];
  sourceLabel: string;
  now?: Date;
}): Promise<string> {
  const daemonIds = [...new Set(input.configuredDaemonIds)].slice(0, 100);
  const daemonSet = new Set(daemonIds);
  const keys = [
    KEYS.app,
    KEYS.defaults,
    KEYS.changes,
    KEYS.editor,
    KEYS.shortcuts,
    KEYS.sidebar,
    KEYS.order,
    KEYS.collapsed,
    KEYS.panel,
    KEYS.layout,
    KEYS.routes,
  ];
  const [
    rawApp,
    rawDefaults,
    rawChanges,
    rawEditor,
    rawShortcuts,
    rawSidebar,
    rawOrder,
    rawCollapsed,
    rawPanel,
    rawLayout,
    rawRoutes,
  ] = await Promise.all(keys.map((key) => input.storage.getItem(key)));
  const transfer: PreferencesTransfer = PreferencesTransferSchema.parse({
    schemaVersion: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    sourceLabel: input.sourceLabel,
    daemonIds,
    app: projectAppPreferences(rawApp, daemonSet),
    createAgent: projectCreateAgentPreferences(rawDefaults),
    changes: projectChangesPreferences(rawChanges),
    preferredEditor: rawEditor && /^[A-Za-z0-9._:-]{1,160}$/.test(rawEditor) ? rawEditor : null,
    keyboardOverrides: projectKeyboardOverrides(rawShortcuts),
    workspaceLayouts: projectWorkspaceLayouts(rawLayout, daemonSet),
    sidebar: projectSidebarPreferences({
      rawSidebar,
      rawOrder,
      rawCollapsed,
      rawRoutes,
      daemonIds: daemonSet,
    }),
    panel: projectPanelPreferences(rawPanel, daemonSet),
    excluded: [
      "hostConnectionsAndPasswords",
      "clientIdentity",
      "pushSubscriptions",
      "draftsAndAttachments",
      "agentAndSessionState",
      "providerFeatureValues",
      "pluginState",
    ],
  });
  const serialized = JSON.stringify(transfer);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREFERENCES_TRANSFER_BYTES) {
    throw new Error("Preferences export exceeds the 256 KiB limit.");
  }
  return serialized;
}

export function matchingDaemonIds(
  transfer: PreferencesTransfer,
  destinationIds: readonly string[],
): string[] {
  const destinations = new Set(destinationIds);
  return transfer.daemonIds.filter((id) => destinations.has(id));
}

export function parseTransferForPreview(contents: string): PreferencesTransfer {
  return parsePreferencesTransfer(contents);
}

export interface PreferencesImportPreview {
  matchedDaemonIds: string[];
  unmatchedDaemonIds: string[];
  personalPathCount: number;
  availableSections: TransferSection[];
}

function countPaths(value: unknown): number {
  if (typeof value === "string") return value.startsWith("/") || /^[A-Za-z]:\\/.test(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countPaths(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, item) => sum + countPaths(item), 0);
  }
  return 0;
}

export function createPreferencesImportPreview(
  transfer: PreferencesTransfer,
  destinationDaemonIds: readonly string[],
): PreferencesImportPreview {
  const matchedDaemonIds = matchingDaemonIds(transfer, destinationDaemonIds);
  return {
    matchedDaemonIds,
    unmatchedDaemonIds: transfer.daemonIds.filter((id) => !matchedDaemonIds.includes(id)),
    personalPathCount: countPaths({
      workspaceLayouts: transfer.workspaceLayouts,
      panel: transfer.panel,
    }),
    availableSections: [
      "appearance",
      "defaults",
      "changes",
      "editor",
      "shortcuts",
      "sidebar",
      "panel",
      "workspace",
    ],
  };
}

function serializeStateUpdate(existing: string | null, updates: Record<string, unknown>): string {
  const parsed = parseObject(existing);
  if (parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)) {
    return JSON.stringify({
      ...parsed,
      state: { ...(parsed.state as Record<string, unknown>), ...updates },
    });
  }
  return JSON.stringify({ ...parsed, ...updates });
}

interface PreferenceImportWrite {
  key: (typeof PREFERENCE_MIGRATION_KEYS)[number];
  value: string;
}

interface PreferenceImportContext {
  storage: PreferenceStorage;
  transfer: PreferencesTransfer;
  matched: ReadonlySet<string>;
  writes: PreferenceImportWrite[];
}

async function appendAppearanceImport(context: PreferenceImportContext): Promise<void> {
  const current = parseObject(await context.storage.getItem(KEYS.app));
  const usageServerId = context.transfer.app.usage.serverId;
  const app = {
    ...context.transfer.app,
    usage: {
      ...context.transfer.app.usage,
      serverId: usageServerId && context.matched.has(usageServerId) ? usageServerId : null,
    },
  };
  context.writes.push({ key: KEYS.app, value: JSON.stringify({ ...current, ...app }) });
}

async function appendObjectImport(
  context: PreferenceImportContext,
  key: typeof KEYS.defaults | typeof KEYS.changes | typeof KEYS.shortcuts,
  value: Record<string, unknown>,
): Promise<void> {
  const current = parseObject(await context.storage.getItem(key));
  context.writes.push({ key, value: JSON.stringify({ ...current, ...value }) });
}

async function buildSidebarViewValue(context: PreferenceImportContext): Promise<string> {
  const source = context.transfer.sidebar ?? {};
  const raw = await context.storage.getItem(KEYS.sidebar);
  const current = persistedState(raw);
  const hostFilters = (source.hostFilters ?? []).filter((id) => context.matched.has(id));
  const updates = {
    ...(source.groupMode ? { groupMode: source.groupMode } : {}),
    ...(source.groupModeByServerId
      ? {
          groupModeByServerId: mergeDaemonMap(
            current.groupModeByServerId,
            source.groupModeByServerId,
            context.matched,
          ),
        }
      : {}),
    ...(source.hostFilters
      ? { hostFilters: mergePlainIdArray(current.hostFilters, hostFilters, context.matched) }
      : {}),
    ...(source.projectFilters
      ? {
          projectFilters: mergeDaemonArray(
            current.projectFilters,
            source.projectFilters,
            context.matched,
          ),
        }
      : {}),
  };
  return serializeStateUpdate(raw, updates);
}

async function buildSidebarOrderValue(context: PreferenceImportContext): Promise<string> {
  const source = context.transfer.sidebar ?? {};
  const raw = await context.storage.getItem(KEYS.order);
  const current = persistedState(raw);
  const updates = {
    ...(source.projectOrder
      ? {
          projectOrder: mergeDaemonArray(
            current.projectOrder,
            source.projectOrder,
            context.matched,
          ),
        }
      : {}),
    ...(source.projectOrderByServerId
      ? {
          projectOrderByServerId: mergeDaemonMap(
            current.projectOrderByServerId,
            source.projectOrderByServerId,
            context.matched,
          ),
        }
      : {}),
    ...(source.pinnedWorkspaceOrder
      ? {
          pinnedWorkspaceOrder: mergeDaemonArray(
            current.pinnedWorkspaceOrder,
            source.pinnedWorkspaceOrder,
            context.matched,
          ),
        }
      : {}),
    ...(source.workspaceOrderByProject
      ? {
          workspaceOrderByProject: mergeWorkspaceMap(
            current.workspaceOrderByProject,
            source.workspaceOrderByProject,
            context.matched,
          ),
        }
      : {}),
  };
  return serializeStateUpdate(raw, updates);
}

async function buildCollapsedSectionsValue(
  context: PreferenceImportContext,
): Promise<string | null> {
  const source = context.transfer.sidebar?.collapsed;
  if (!source) return null;
  const raw = await context.storage.getItem(KEYS.collapsed);
  const current = persistedState(raw);
  const updates = {
    ...(source.collapsedProjectKeys
      ? {
          collapsedProjectKeys: mergeDaemonArray(
            current.collapsedProjectKeys,
            source.collapsedProjectKeys,
            context.matched,
          ),
        }
      : {}),
    ...(source.collapsedWorkspaceGroupKeys
      ? { collapsedWorkspaceGroupKeys: source.collapsedWorkspaceGroupKeys }
      : {}),
    ...(source.collapsedStatusGroupKeys
      ? { collapsedStatusGroupKeys: source.collapsedStatusGroupKeys }
      : {}),
    ...(source.collapsedPinned !== undefined ? { collapsedPinned: source.collapsedPinned } : {}),
  };
  return serializeStateUpdate(raw, updates);
}

async function buildSidebarRoutesValue(context: PreferenceImportContext): Promise<string> {
  const raw = await context.storage.getItem(KEYS.routes);
  const current = persistedState(raw);
  const source = context.transfer.sidebar?.serviceRouteByServerId ?? {};
  const byServerId = mergeDaemonMap(current.byServerId, source, context.matched);
  return serializeStateUpdate(raw, { byServerId });
}

async function appendSidebarImport(context: PreferenceImportContext): Promise<void> {
  const [viewValue, orderValue, collapsedValue, routeValue] = await Promise.all([
    buildSidebarViewValue(context),
    buildSidebarOrderValue(context),
    buildCollapsedSectionsValue(context),
    buildSidebarRoutesValue(context),
  ]);
  context.writes.push({ key: KEYS.sidebar, value: viewValue });
  context.writes.push({ key: KEYS.order, value: orderValue });
  if (collapsedValue !== null) context.writes.push({ key: KEYS.collapsed, value: collapsedValue });
  context.writes.push({ key: KEYS.routes, value: routeValue });
}

async function appendPanelImport(context: PreferenceImportContext): Promise<void> {
  const source = context.transfer.panel ?? {};
  const raw = await context.storage.getItem(KEYS.panel);
  const current = persistedState(raw);
  const existingDesktop =
    current.desktop && typeof current.desktop === "object"
      ? (current.desktop as Record<string, unknown>)
      : {};
  const updates = {
    ...source,
    ...(source.desktop ? { desktop: { ...existingDesktop, ...source.desktop } } : {}),
    ...(source.expandedPathsByWorkspace
      ? {
          expandedPathsByWorkspace: {
            ...(current.expandedPathsByWorkspace as Record<string, unknown> | undefined),
            ...workspaceScopedEntries(source.expandedPathsByWorkspace, context.matched),
          },
        }
      : {}),
    ...(source.collapsedFilePathsByWorkspace
      ? {
          collapsedFilePathsByWorkspace: {
            ...(current.collapsedFilePathsByWorkspace as Record<string, unknown> | undefined),
            ...workspaceScopedEntries(source.collapsedFilePathsByWorkspace, context.matched),
          },
        }
      : {}),
  };
  context.writes.push({ key: KEYS.panel, value: serializeStateUpdate(raw, updates) });
}

async function appendWorkspaceImport(context: PreferenceImportContext): Promise<void> {
  const raw = await context.storage.getItem(KEYS.layout);
  const current = persistedState(raw);
  const destinationLayouts = current.layoutByWorkspace as Record<string, unknown> | undefined;
  const sourceLayouts = Object.fromEntries(
    Object.entries(context.transfer.workspaceLayouts ?? {})
      .filter(([key]) => {
        const separator = key.indexOf(":");
        return separator > 0 && context.matched.has(key.slice(0, separator));
      })
      .map(([key, layout]) => {
        const value = layout as { root: unknown; focusedPaneId: string | null };
        return [key, { root: value.root, focusedPaneId: value.focusedPaneId }];
      }),
  );
  const value = serializeStateUpdate(raw, {
    layoutByWorkspace: { ...destinationLayouts, ...sourceLayouts },
  });
  context.writes.push({ key: KEYS.layout, value });
}

export async function buildSelectedPreferencesImport(input: {
  storage: PreferenceStorage;
  transfer: PreferencesTransfer;
  destinationDaemonIds: readonly string[];
  selected: readonly TransferSection[];
}): Promise<PreferenceImportWrite[]> {
  const context: PreferenceImportContext = {
    storage: input.storage,
    transfer: input.transfer,
    matched: new Set(matchingDaemonIds(input.transfer, input.destinationDaemonIds)),
    writes: [],
  };
  const selected = new Set(input.selected);
  const appenders: Record<TransferSection, () => Promise<void>> = {
    appearance: () => appendAppearanceImport(context),
    defaults: () => appendObjectImport(context, KEYS.defaults, input.transfer.createAgent),
    changes: () => appendObjectImport(context, KEYS.changes, input.transfer.changes),
    editor: async () => {
      context.writes.push({ key: KEYS.editor, value: input.transfer.preferredEditor ?? "" });
    },
    shortcuts: () => appendObjectImport(context, KEYS.shortcuts, input.transfer.keyboardOverrides),
    sidebar: () => appendSidebarImport(context),
    panel: () => appendPanelImport(context),
    workspace: () => appendWorkspaceImport(context),
  };
  for (const section of selected) await appenders[section]();
  return context.writes;
}
