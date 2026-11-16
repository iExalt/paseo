import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { resolveOpenCodePatchTarget } from "./postinstall-patches-target.mjs";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
const openCodePatchTarget = resolveOpenCodePatchTarget(existsSync);
const patchedPackages = [
  // Gradle 9.8 needs newer Kotlin metadata support; Expo's Pika compiler caps
  // the version at 2.3.20. Keep these plugin compilers consistent until Expo and
  // React Native ship compatible pins.
  {
    nodeModulesPath: "node_modules/@react-native/gradle-plugin",
    patchPrefix: "@react-native+gradle-plugin+",
  },
  {
    nodeModulesPath: "node_modules/expo-modules-autolinking",
    patchPrefix: "expo-modules-autolinking+",
  },
  {
    nodeModulesPath: "node_modules/expo-dev-launcher",
    patchPrefix: "expo-dev-launcher+",
  },
  // Backport for expo-modules-core 57.0.24: https://github.com/expo/expo/pull/49634.
  // Remove the Activity hunks when Expo includes that fix; retain the Gradle plugin
  // compiler alignment until Expo ships a compatible pin.
  {
    nodeModulesPath: "node_modules/expo-modules-core",
    patchPrefix: "expo-modules-core+",
  },
  {
    nodeModulesPath: "node_modules/@expo/cli",
    patchPrefix: "@expo+cli+",
  },
  // Registry cleanup: remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  // Adaptive themes: keep until colorScheme reads no longer consume listener-owned media changes.
  // withUnistyles: also keep the uniProps filter until upstream consumes its control prop.
  // Android: retain the project NDK pin; configuration fixes are upstream in 3.8.1.
  {
    nodeModulesPath: "node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
  },
  // Portal state lives in a store that each host subscribes to. As the provider's context value it
  // changed on every portal add, update and remove, and React searched every fiber under the
  // provider (the whole app) for consumers. No upstream fix; keep while the app uses this package.
  // Keyed hosts: backport of https://github.com/gorhom/react-native-portal/pull/62, unreleased
  // after 1.0.14. Remove the PortalHost hunks when an installed release includes it.
  {
    nodeModulesPath: "node_modules/@gorhom/portal",
    patchPrefix: "@gorhom+portal+",
  },
  // Backport of React 19.3.0 to the development builds: clear each render timing after reporting
  // it. The browser keeps every performance measure for the life of the page, so a development
  // session held millions of them and gigabytes of memory. Remove when react-dom is >= 19.3.0.
  {
    nodeModulesPath: "node_modules/react-dom",
    patchPrefix: "react-dom+",
  },
  // Backport of https://github.com/software-mansion/react-native-reanimated/pull/10435
  // (Reanimated 4.7.1): skip synchronous Android prop updates for unmounted view tags
  // instead of throwing and printing a full stack trace on the UI thread per tag per event.
  // Remove when the installed Reanimated is >= 4.7.1.
  {
    nodeModulesPath: "node_modules/react-native-reanimated",
    patchPrefix: "react-native-reanimated+",
  },
  // The native chat timeline. The patch's header lists its hunks and the upstream issue.
  {
    nodeModulesPath: "packages/app/node_modules/@legendapp/list",
    patchPrefix: "@legendapp+list+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "node_modules/@legendapp/list",
    patchPrefix: "@legendapp+list+",
  },
  // Native sidebar lists. Besides gesture sessions and panel-gesture arbitration, the drop gives
  // each moved cell a fresh transform host. Reanimated re-applies a view's last animated
  // transform to every React commit, so a reused host painted one frame of new order plus old
  // drag translate (upstream computerjazz/react-native-draggable-flatlist#621, open).
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  // Web pointer capture: capture only pointers the handler still tracks after pointer-down, so a
  // touch-only pan that fails the mouse leaves browser text selection alone. Keep until upstream
  // stops capturing pointers a handler has rejected.
  // Android mouse buttons: backport of
  // https://github.com/software-mansion/react-native-gesture-handler/pull/4265 (2.33.0), so a
  // mouse click reaches Tap and LongPress. Remove the RNGestureHandlerRootView, Extensions and
  // LongPressGestureHandler hunks at >= 2.33.0.
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
  // Exports BottomSheetModalInternalProvider so a subtree can host its own sheets on the shared
  // modal stack (see packages/app/src/components/ui/isolated-bottom-sheet-modal/host-scope.tsx), and
  // keeps a dismissing modal's status through its final onChange(-1), so a modal with
  // enableDismissOnClose=false that unmounts while presented still leaves the portal, and removes
  // the portal of a modal that unmounts before its opening animation starts.
  // Dimensions subscription cleanup: https://github.com/gorhom/react-native-bottom-sheet/issues/2734
  // and https://github.com/gorhom/react-native-bottom-sheet/pull/2751. Remove the useAnimatedLayout
  // hunks once an installed release includes the cleanup; retain the other local hunks.
  {
    nodeModulesPath: "node_modules/@gorhom/bottom-sheet",
    patchPrefix: "@gorhom+bottom-sheet+",
  },
  // Android resize: retain until upstream clears descendant geometry when the SVG canvas resizes.
  // The native pixel regression is included in the patch; preserve the separate transform hunks.
  // npm nests or hoists this package depending on the rest of the tree; patch either.
  {
    nodeModulesPath: "packages/app/node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
    cwd: "packages/app",
  },
  // Reconcile ResponderEventPlugin trackedTouchCount and ResponderTouchHistoryStore touchBank with
  // nativeEvent.touches.length so an unmatched touch start or single-pointer synthetic cancel
  // (e.g. Modal dismiss while touching, RNGH pinch takeover, or double ACTION_DOWN in
  // ReactRootView/ReactModalHostView) self-heals instead of leaving trackedTouchCount > 0 or stale
  // active contacts in touchBank. Remove once upstream React/React Native reconciles both.
  {
    nodeModulesPath: "node_modules/react-native",
    patchPrefix: "react-native+",
  },
  // Keep Android PasteTextInput aligned with RN AndroidTextInput (omit iOS-only
  // onSelectionChangeShouldSetResponder), plus ref/eventCount/trailing-newline fixes.
  {
    nodeModulesPath: "node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
  },
  // Android's onShouldStartLoadWithRequest reports isTopFrame; see the browser pane.
  {
    nodeModulesPath: "node_modules/react-native-webview",
    patchPrefix: "react-native-webview+",
  },
  // Android image paste, local and not upstream as of 2.0.1: take the MIME type from the content
  // provider when the URI name has no usable extension (keyboard commits), and send URI-only
  // image clips to onPaste from every paste route: the long-press menu, Ctrl+V and keyboard
  // performContextMenuAction(paste). Lists image MIME types before "*/*" for keyboards that match
  // them literally, and logs each route and keyboard paste call under the PasteInput tag. Keep
  // these hunks across upgrades.
  {
    nodeModulesPath: "node_modules/@mattermost/react-native-paste-input",
    patchPrefix: "@mattermost+react-native-paste-input+",
  },
  // Backport of https://github.com/mermaid-js/mermaid/pull/8459 (lexer half): a flowchart label
  // with an "@" parses. The patch header has the details. Remove when the app uses mermaid 12.
  {
    nodeModulesPath: "node_modules/mermaid",
    patchPrefix: "mermaid+",
  },
  ...(openCodePatchTarget ? [openCodePatchTarget] : []),
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (!existsSync("patches") || installedPackages.length === 0) {
  process.exit(0);
}

const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";

let failed = false;
for (const [index, { nodeModulesPath, patchPrefix, cwd = "." }] of installedPackages.entries()) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const outcome = applyPatches(cwd, files, index);
  if (outcome === "applied") {
    continue;
  }
  failed = true;
  if (outcome === "unavailable") {
    continue;
  }
  // patch-package cannot apply a patch that changed after an earlier version of it was
  // applied. Without the package, the next install fetches it clean and applies the patch.
  rmSync(nodeModulesPath, { recursive: true, force: true });
  console.error(
    `postinstall-patches: removed ${nodeModulesPath} because its patch did not apply. ` +
      "Run npm install again to reinstall it with the current patch. " +
      "If it fails again on the clean package, the patch is out of date and must be regenerated.",
  );
}

process.exit(failed ? 1 : 0);

function applyPatches(cwd, files, index) {
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${index}`);
  mkdirSync(tempPatchDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir), "--error-on-fail"], {
      cwd,
      shell: isWindows,
      stdio: "inherit",
      windowsHide: true,
    });
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
  }

  if (result.error) {
    console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
    return "unavailable";
  }
  return result.status === 0 ? "applied" : "rejected";
}
