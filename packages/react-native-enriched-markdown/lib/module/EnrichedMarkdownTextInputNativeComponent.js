"use strict";

import { codegenNativeComponent, codegenNativeCommands } from 'react-native';
export const Commands = codegenNativeCommands({
  supportedCommands: ['focus', 'blur', 'setValue', 'setSelection', 'toggleBold', 'toggleItalic', 'toggleUnderline', 'toggleStrikethrough', 'toggleSpoiler', 'toggleHeading', 'toggleUnorderedList', 'toggleOrderedList', 'indentList', 'outdentList', 'setLink', 'insertLink', 'insertText', 'insertMention', 'startMention', 'removeLink', 'copyToClipboard', 'undo', 'redo', 'requestMarkdown', 'requestCaretRect']
});
export default codegenNativeComponent('EnrichedMarkdownTextInput', {
  interfaceOnly: true
});
//# sourceMappingURL=EnrichedMarkdownTextInputNativeComponent.js.map
