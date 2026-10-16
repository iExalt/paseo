import type { ParityManifest } from "./check";

const equivalent = { kind: "equivalent" } as const;

/**
 * How each platform difference in the app is classified. check.test.ts fails when a
 * new platform split or gated settings section is missing here, or an entry goes
 * stale. Runtime gates inside shared files are listed by hand; the test cannot find
 * new ones. A chunk that closes a gap deletes its entries in the same commit.
 * See docs/PLATFORM_PARITY_PLAN.md.
 */
export const PARITY_MANIFEST: ParityManifest = {
  splitModules: {
    "agent-stream/chat-find/index": {
      kind: "gap",
      chunk: "C1",
      reason: "Native renders no chat find bar",
    },
    "agent-stream/chat-outline/rail": {
      kind: "gap",
      chunk: "E3",
      reason: "Native renders no outline rail, even on wide layouts",
    },
    "appearance/apply-root-font": {
      kind: "deliberate",
      reason: "Native has no global font cascade for the interface font",
    },
    "assistant-selection-copy/surface": {
      kind: "gap",
      chunk: "F2",
      reason: "Native copies a reply selection as plain text",
    },
    "attachments/use-workspace-file-drag-source": {
      kind: "equivalent",
      note: "Native adds explorer files to chat from a menu instead of dragging",
    },
    "audio/audio-engine": equivalent,
    "components/draggable-list": equivalent,
    "components/markdown-text": equivalent,
    "components/markdown/fence/mermaid/host": equivalent,
    "components/project-icon-image": equivalent,
    "components/sortable-inline-list": equivalent,
    "components/terminal-emulator": equivalent,
    "components/status-ring/clock": equivalent,
    "components/status-ring/index": equivalent,
    "components/ui/isolated-bottom-sheet-modal/sheet-backdrop": equivalent,
    "components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar": equivalent,
    "components/ui/press-highlight": equivalent,
    "components/ui/scroll-view": equivalent,
    "components/ui/text-input/text-input": equivalent,
    "components/zoomable-viewport/index": equivalent,
    "composer/dock/index": equivalent,
    "composer/dock/internal/background": equivalent,
    "composer/input/height": equivalent,
    "desktop/browser/pane/index": {
      kind: "gap",
      chunk: "F1",
      reason: "Native shows an unavailable message instead of a browser tab",
    },
    "file-pane/editor/view": {
      kind: "gap",
      chunk: "D1",
      reason: "Native shows a placeholder instead of the editor",
    },
    "file-pane/html-preview": equivalent,
    "file-pane/source/view": {
      kind: "gap",
      chunk: "C2",
      reason: "The native source view has no find",
    },
    "git/diff-document/horizontal-scroll": equivalent,
    "git/diff-document/paint": equivalent,
    "git/diff-document/surface": equivalent,
    "hooks/image-attachment-picker": equivalent,
    "hooks/use-audio-recorder": equivalent,
    "hooks/use-color-scheme": equivalent,
    "hooks/use-dictation-audio-source": equivalent,
    "hooks/use-keyboard-visibility": equivalent,
    "keyboard/shift/internal/translate": equivalent,
    "native/ios-hardware-keyboard-submit": {
      kind: "gap",
      chunk: "E1",
      reason: "Only iOS submits the composer from a hardware keyboard",
    },
    "panels/retained-chat-content": equivalent,
    "permissions/platform-permissions": equivalent,
    "plugins/react-native/clipboard": equivalent,
    "projects/icon-cache-storage": equivalent,
    "push-notifications/index": {
      kind: "equivalent",
      note: "Desktop notifies through the OS; native subscribes to push",
    },
    "runtime/replica-cache/legacy-cleanup": equivalent,
    "runtime/replica-cache/row-store": equivalent,
    "runtime/replica-cache/row-store-factory": equivalent,
    "runtime/websocket-factory": equivalent,
    "screens/settings/notifications/notifications-section": equivalent,
    "styles/install-web-scrollbar-styles": equivalent,
    "styles/unistyles-inline-style": equivalent,
  },
  settingsSections: {
    browser: { kind: "gap", chunk: "F1", reason: "Browser data settings need browser tabs" },
    editor: { kind: "gap", chunk: "D1", reason: "Editor settings need the native editor" },
    shortcuts: {
      kind: "gap",
      chunk: "E1",
      reason: "Shortcuts need hardware keyboard support on native",
    },
    integrations: { kind: "deliberate", reason: "Installs the CLI on the local machine" },
    notifications: {
      kind: "equivalent",
      note: "Hidden only in a plain browser; native has its own section",
    },
    permissions: { kind: "equivalent", note: "Hidden only in a plain browser" },
  },
  runtimeGates: {
    "android/fork-updates/store.ts": {
      kind: "deliberate",
      reason: "iOS updates come from the App Store and TestFlight",
    },
    "app/_layout.tsx": {
      kind: "deliberate",
      reason: "Window chrome, favicon status and the quitting overlay are desktop window concepts",
    },
    "components/add-host-method-modal.tsx": {
      kind: "deliberate",
      reason: "Remote SSH onboarding needs a local SSH client",
    },
    "screens/settings-screen.tsx": {
      kind: "deliberate",
      reason: "Open location and built-in daemon controls need Electron",
    },
    "workspace/open-in-editor/button.tsx": {
      kind: "deliberate",
      reason: "Opening an editor needs the local machine",
    },
    "workspace/open-in-file-manager/menu-item.tsx": {
      kind: "deliberate",
      reason: "Opening a file manager needs the local machine",
    },
    "keyboard/availability.ts": {
      kind: "gap",
      chunk: "E1",
      reason: "Shortcuts are off on native, including tablets with keyboards",
    },
    "file-pane/pane.tsx": { kind: "gap", chunk: "D1", reason: "Editing requires isWeb" },
    "constants/layout.ts": {
      kind: "gap",
      chunk: "E2",
      reason: "Pane splits require isWeb",
    },
    "terminal/find/index.tsx": {
      kind: "gap",
      chunk: "C3",
      reason: "Terminal find opens only from a web keyboard listener",
    },
  },
};
