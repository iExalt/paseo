/** Side-by-side diff needs width, not a platform: wide native layouts get it too. */
export function canUseSplitDiffLayout(input: { isCompact: boolean }): boolean {
  return !input.isCompact;
}
