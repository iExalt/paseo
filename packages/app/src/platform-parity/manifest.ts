import type { ParityManifest } from "./check";

const equivalent = { kind: "equivalent" } as const;
const FOLLOWS_UPSTREAM_WEB_ONLY =
  "Upstream keeps this web-only; the fork follows it rather than porting its old native version (C2, D1, E2b)";
const PANE_DRAG_WEB_ONLY =
  "Pane splits are web-only, following upstream, so drag-to-split and tab drag are too";

/**
 * How each platform difference in the app is classified. check.test.ts fails when a
 * new platform split or gated settings section is missing here, or an entry goes
 * stale. Runtime gates inside shared files are listed by hand; the test cannot find
 * new ones. A chunk that closes a gap deletes its entries in the same commit.
 */
export const PARITY_MANIFEST: ParityManifest = {
  splitModules: {
    "add-project-flow/focused-control": {
      kind: "equivalent",
      note: "Web checks whether the focused DOM control owns Enter. Native sends Enter to the sheet.",
    },
    "chat-rail/index": {
      kind: "deliberate",
      reason: "The chat outline is a web affordance. Native reserves no column rail inset.",
    },
    "components/model-browser-focus": {
      kind: "equivalent",
      note: "Web distinguishes DOM keyboard focus from pointer input. Native forwards keyboard or remote focus.",
    },
    "navigation/route-leave-guard/index": {
      kind: "equivalent",
      note: "Web guards browser history, while React Navigation owns native back and swipe gestures.",
    },
    "components/ui/autocomplete-popover/internal/frame": {
      kind: "equivalent",
      note: "Native measures the anchor on the UI thread; web observes its DOM layout before paint",
    },
    "components/zoomable-viewport/image-size": {
      kind: "deliberate",
      reason:
        "Web uses the browser 300 by 150 fallback for images without intrinsic dimensions; native rejects a missing size",
    },
    "appearance/text": {
      kind: "equivalent",
      note: "Web subscribes the text leaf to font tokens; native Text resolves the theme directly",
    },
    "components/ui/menu/keyboard-navigation": {
      kind: "gap",
      chunk: "E3",
      reason:
        "Arrow, Home, End and activation navigation uses DOM focus on web; native implementation has no menu navigation",
    },
    "composer/input/hardware-back-exit": {
      kind: "deliberate",
      reason:
        "Android hardware Back leaves fullscreen; other platforms have no Android BackHandler",
    },
    "composer/pasted-text": {
      kind: "deliberate",
      reason:
        "Web converts linked HTML clipboard content to Markdown; native keeps platform clipboard handling",
    },
    "keyboard/internal/conventions": {
      kind: "deliberate",
      reason:
        "Native keeps desktop shortcut conventions and its existing Return path; web supports configurable composer send keys",
    },
    "keyboard/internal/dom-popover": {
      kind: "deliberate",
      reason: "Only web has DOM popovers whose Escape handling must precede agent shortcuts",
    },
    "keyboard/internal/focused-text-input": {
      kind: "equivalent",
      note: "Native reads TextInput focus; web classifies focus from DOM keyboard events",
    },
    "keyboard/internal/overlay-registration": {
      kind: "equivalent",
      note: "Both register the highest overlay; web additionally traps and restores DOM focus",
    },
    "keyboard/internal/presence": {
      kind: "equivalent",
      note: "Native receives keyboard presence from the OS; web observes pointer capability and modifier keys",
    },
    "keyboard/internal/sources/hardware": {
      kind: "equivalent",
      note: "Android and iOS native modules publish hardware shortcuts and presence; web sources use DOM events",
    },
    "keyboard/internal/sources/index": {
      kind: "equivalent",
      note: "Native subscribes its hardware source; web subscribes DOM and Electron guest sources",
    },
    "keyboard/internal/use-focus-surface": {
      kind: "equivalent",
      note: "Native declares the focused surface; web classifies it from the DOM event target",
    },
    "window-layout/index": {
      kind: "deliberate",
      reason:
        "iOS probes native window geometry and safe insets; other platforms use the shared layout without that probe",
    },
    "agent-stream/chat-find/index": {
      kind: "equivalent",
      note: "Web marks DOM ranges; native highlights the occurrence in the Markdown source it draws",
    },
    "agent-stream/chat-outline/rail": {
      kind: "gap",
      chunk: "E3",
      reason:
        "Tablet checks skipped (no device); scrubbing and the landscape-only rail are unverified on hardware",
    },
    "appearance/apply-root-font": {
      kind: "deliberate",
      reason: "Native has no global font cascade for the interface font",
    },
    "appearance/system-bars": {
      kind: "equivalent",
      note: "Only Android's edge-to-edge bars take their icon style from the theme",
    },
    "assistant-selection-copy/surface": {
      kind: "equivalent",
      note: "Native copies part of a reply with its Markdown from Select text",
    },
    "attachments/use-workspace-file-drag-source": {
      kind: "equivalent",
      note: "Native adds explorer files to chat from a menu instead of dragging",
    },
    "audio/audio-engine": equivalent,
    "components/assistant-message-render-limit": {
      kind: "deliberate",
      reason:
        "Web caps very long replies to bound DOM size; native hands the whole reply to its parser, so it shows all of it",
    },
    "components/draggable-list": equivalent,
    "components/import-session-list": {
      kind: "deliberate",
      reason:
        "Upstream virtualizes long Import Session lists on web only; native keeps the sheet's ScrollView",
    },
    "components/markdown/renderers": {
      kind: "equivalent",
      note: "Web draws code blocks and link tooltips in JS; native draws code blocks in the library",
    },
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
    "components/workspace-tab-drag-scope": { kind: "deliberate", reason: PANE_DRAG_WEB_ONLY },
    "composer/dock/internal/fullscreen": {
      kind: "equivalent",
      note: "Native reserves the soft keyboard's space; web has none to reserve",
    },
    "composer/dock/index": equivalent,
    "composer/dock/internal/background": equivalent,
    "composer/input/height": equivalent,
    "desktop/browser/pane/index": {
      kind: "deliberate",
      reason:
        "A plain browser cannot host other sites in a tab; native tabs have no devtools, annotation, automation, viewport presets or downloads, which drive Electron's browser",
    },
    "desktop/browser/settings/clear-browser-data": {
      kind: "equivalent",
      note: "Native clears the process-wide web view store through PaseoWebviewData",
    },
    "diagnostics/agent-switches-source": {
      kind: "equivalent",
      note: "Agent debug switches come from sessionStorage on web and adb intent extras through PaseoAgentSwitches on Android",
    },
    "file-panels/document-frame/index": {
      kind: "equivalent",
      note: "Native shows documents in a WebView; Android's has no inline viewer for PDF and other documents",
    },
    "file-panels/html-preview": equivalent,
    "file-panels/use-reader-bottom-inset": {
      kind: "equivalent",
      note: "Native reserves the system bar's overlap; web has no native system bar",
    },
    "file-panels/source/editor/view": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "file-panels/source/readonly/view": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "git/diff-document/horizontal-scroll": equivalent,
    "git/diff-document/paint": equivalent,
    "git/diff-document/surface": equivalent,
    "hooks/image-attachment-picker": equivalent,
    "hooks/use-audio-recorder": equivalent,
    "hooks/use-color-scheme": equivalent,
    "hooks/use-dictation-audio-source": equivalent,
    "keyboard/shift/internal/translate": equivalent,
    "native/hardware-keyboard": {
      kind: "equivalent",
      note: "Web reads DOM key events; native gets hardware keys from the PaseoHardwareKeyboard module",
    },
    "notification-dismissal/start-presented": {
      kind: "equivalent",
      note: "Native mirrors pushes in the notification shade; web and desktop track notifications as they send them",
    },
    "notification-open/source": {
      kind: "equivalent",
      note: "Each platform reports notification taps from its own source: expo-notifications, Electron, or the web click event",
    },
    "panels/retained-chat-content": equivalent,
    "permissions/platform-permissions": equivalent,
    "plugins/client-bundles/index": {
      kind: "equivalent",
      note: "Verified plugin bundles use IndexedDB on web and the file cache on native",
    },
    "plugins/react-native/clipboard": equivalent,
    "projects/icon-cache-storage": equivalent,
    "push-notifications/background-lifecycle": {
      kind: "deliberate",
      reason:
        "Android uses a headless task for app-owned notification posting; other platforms retain their existing notification delivery paths",
    },
    "push-notifications/index": {
      kind: "equivalent",
      note: "Desktop notifies through the OS; native subscribes to push",
    },
    "runtime/replica-cache/legacy-cleanup": equivalent,
    "runtime/replica-cache/row-store": equivalent,
    "runtime/replica-cache/row-store-factory": equivalent,
    "runtime/websocket-factory": equivalent,
    "screens/workspace/explorer-sidebar/geometry": {
      kind: "equivalent",
      note: "Web resizes the explorer with pointer events; native with a pan gesture",
    },
    "screens/settings/notifications/notifications-section": equivalent,
    "styles/install-web-scrollbar-styles": equivalent,
    "styles/unistyles-inline-style": equivalent,
    "utils/decode-utf8": {
      kind: "equivalent",
      note: "Hermes has no native TextDecoder, so native decodes through string builtins",
    },
  },
  settingsSections: {
    notifications: {
      kind: "equivalent",
      note: "Device preferences appear on native, Electron and browsers with the Notification API.",
    },
    shortcuts: {
      kind: "gap",
      chunk: "E1",
      reason: "Native lists bindings read-only; rebinding captures DOM key events (deferred)",
    },
  },
  runtimeGates: {
    "android/fork-updates/updater.ts": {
      kind: "deliberate",
      reason: "iOS updates come from the App Store and TestFlight",
    },
    "app/_layout.tsx": {
      kind: "deliberate",
      reason: "Window chrome, favicon status and the quitting overlay are desktop window concepts",
    },
    "constants/layout.ts": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "file-panels/source/panel.tsx": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
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
  },
};
