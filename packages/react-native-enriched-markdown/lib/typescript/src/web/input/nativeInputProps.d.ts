import type { ViewProps } from 'react-native';
import type { EnrichedMarkdownTextInputProps as NativeInputProps } from '../../EnrichedMarkdownTextInput';
import type { EnrichedMarkdownTextInputProps as WebInputProps } from '../../EnrichedMarkdownTextInput.web';
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
type NativeOnlyInputPropName = Exclude<keyof NativeInputProps, keyof WebInputProps | keyof ViewProps>;
export declare function filterNativeOnlyInputProps<T extends object>(props: T): Omit<T, NativeOnlyInputPropName | 'hitSlop'>;
export {};
//# sourceMappingURL=nativeInputProps.d.ts.map