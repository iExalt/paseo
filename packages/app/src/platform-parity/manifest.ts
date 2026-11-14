const FOLLOWS_UPSTREAM_WEB_ONLY =
  "Upstream keeps this web-only; the fork follows it rather than porting its old native version (C2, D1, E2b)";
  "Pane splits are web-only, following upstream, so drag-to-split and tab drag are too";
      note: "Web marks DOM ranges; native highlights the occurrence in the Markdown source it draws",
    "appearance/system-bars": {
      kind: "equivalent",
      note: "Only Android's edge-to-edge bars take their icon style from the theme",
    },
    "components/assistant-message-render-limit": {
      kind: "deliberate",
      reason:
        "Web caps very long replies to bound DOM size; native hands the whole reply to its parser, so it shows all of it",
    },
    "components/import-session-list": {
      kind: "deliberate",
      reason:
        "Upstream virtualizes long Import Session lists on web only; native keeps the sheet's ScrollView",
    },
    "components/markdown/renderers": {
      kind: "equivalent",
      note: "Web draws code blocks and link tooltips in JS; native draws code blocks in the library",
    },
    "components/workspace-tab-drag-scope": { kind: "deliberate", reason: PANE_DRAG_WEB_ONLY },
    "composer/dock/internal/fullscreen": {
      kind: "equivalent",
      note: "Native reserves the soft keyboard's space; web has none to reserve",
    },
    "composer/input/fullscreen-exit": {
      kind: "equivalent",
      note: "Back leaves the fullscreen composer on native; Escape does on web",
    },
    "file-panels/document-frame/index": {
      note: "Native shows documents in a WebView; Android's has no inline viewer for PDF and other documents",
    "file-panels/html-preview": equivalent,
    "file-panels/source/editor/view": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "file-panels/source/readonly/view": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "notification-open/source": {
      kind: "equivalent",
      note: "Each platform reports notification taps from its own source: expo-notifications, Electron, or the web click event",
    },
    "plugins/client-bundles/index": {
      kind: "equivalent",
      note: "Verified plugin bundles use IndexedDB on web and the file cache on native",
    },
    "screens/workspace/explorer-sidebar/geometry": {
      kind: "equivalent",
      note: "Web resizes the explorer with pointer events; native with a pan gesture",
    },
    "utils/decode-utf8": {
      kind: "equivalent",
      note: "Hermes has no native TextDecoder, so native decodes through string builtins",
    },
    "android/fork-updates/updater.ts": {
    "constants/layout.ts": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
    "file-panels/source/panel.tsx": { kind: "deliberate", reason: FOLLOWS_UPSTREAM_WEB_ONLY },
