"use strict";

/**
 * Native-only props, dropped before the rest is spread onto the editor's
 * `<div>`: otherwise React warns about each one, and values like
 * `markdownstyle="[object Object]"` land in the DOM.
 *
 * The set is derived (native prop names minus web's and minus ViewProps), so a
 * native-only prop added to `EnrichedMarkdownTextInput.tsx` fails the build
 * here until it is listed. `hitSlop` (a ViewProp) is listed by hand because it
 * reaches the DOM as an invalid attribute just the same.
 *
 * Every import here is type-only, so nothing from `react-native` reaches the
 * web bundle.
 */

// The index signature keeps this compiling where the native prop type cannot
// be told apart from the web one: under a `.web` module suffix (an app's
// tsconfig) the import above resolves to the web file and the derived set is
// empty. The library's own build still requires every derived name.
const NATIVE_ONLY_INPUT_PROP_NAMES = {
  ref: true,
  scrollEnabled: true,
  markdownShortcuts: true,
  multiline: true,
  onCaretRectChange: true,
  onLinkDetected: true,
  mentionIndicators: true,
  onStartMention: true,
  onChangeMention: true,
  onEndMention: true,
  contextMenuItems: true,
  selectionMenuConfig: true,
  formatMenuConfig: true,
  linkRegex: true,
  writingDirection: true,
  onPress: true,
  onPressIn: true,
  onPressOut: true,
  rejectResponderTermination: true,
  hitSlop: true
};
const NATIVE_ONLY_INPUT_PROPS = new Set(Object.keys(NATIVE_ONLY_INPUT_PROP_NAMES));
export function filterNativeOnlyInputProps(props) {
  const result = {};
  for (const [key, value] of Object.entries(props)) {
    if (!NATIVE_ONLY_INPUT_PROPS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
//# sourceMappingURL=nativeInputProps.js.map
