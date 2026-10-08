export const COMPLETION_SUBJECT_MAX_LENGTH = 16_384;

export interface CompletionSubject {
  readonly turnId: string;
  readonly text: string;
  readonly completeness: "complete" | "incomplete";
}
