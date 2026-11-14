/** Only the part of a reader covered by the system bar needs scrollable padding. */
export function readerBottomOverlap(input: {
  frameTop: number;
  frameHeight: number;
  windowHeight: number;
  bottomInset: number;
}): number {
  const { frameTop, frameHeight, windowHeight, bottomInset } = input;
  return Math.max(
    0,
    Math.min(bottomInset, frameHeight, frameTop + frameHeight - (windowHeight - bottomInset)),
  );
}
