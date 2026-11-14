export function shouldAnimateNativeScrollToBottom(input: {
  offsetY: number;
  viewportHeight: number;
  windowSize: number;
}): boolean {
  // VirtualizedList splits the extra window around the viewport. An animated
  // jump farther than the bottom-side overscan crosses unmounted history.
  const bottomOverscanHeight = ((input.windowSize - 1) / 2) * input.viewportHeight;
  return input.viewportHeight > 0 && input.offsetY <= bottomOverscanHeight;
}

// The offset the list records when it asks for the bottom. An instant jump lands before the
// next scroll event, so the bottom can be recorded at once. An animated one only gets there
// through its own scroll events: recording the bottom early lets the anchor controller verify
// the jump before it lands and then read the animation's scroll events as the reader
// scrolling away.
export function planNativeScrollToBottom(input: {
  animated: boolean;
  offsetY: number;
  viewportHeight: number;
  windowSize: number;
}): { animated: boolean; recordedOffsetY: number } {
  const animated = input.animated && shouldAnimateNativeScrollToBottom(input);
  return { animated, recordedOffsetY: animated ? input.offsetY : 0 };
}
