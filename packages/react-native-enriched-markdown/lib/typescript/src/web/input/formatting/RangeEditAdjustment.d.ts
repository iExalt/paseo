import type { RangeBounds } from '../model/rangeBounds';
/**
 * Bounds are mutated in place; the returned array drops ranges deleted
 * outright or clipped to zero length.
 *
 * Insert-only edits at exactly `range.end` do NOT grow the range - whether
 * typed text continues a style is decided by the pending-styles layer, and
 * links must never auto-extend. An insert at exactly `range.start` shifts the
 * range so the typed characters stay outside it (a character typed before a
 * bold run must not become bold).
 *
 * `inheritsReplacementAtStart`: when true for a range whose start is the edit
 * location, replacement text joins the range (autocorrect over a styled word
 * keeps the style); when false, the plain clip/remove behavior applies.
 */
export declare function adjustRangesForEdit<T extends RangeBounds>(ranges: T[], editLocation: number, deletedLength: number, insertedLength: number, inheritsReplacementAtStart?: (range: T) => boolean): T[];
//# sourceMappingURL=RangeEditAdjustment.d.ts.map