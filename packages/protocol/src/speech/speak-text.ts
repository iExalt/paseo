export const MAX_SPEAK_TEXT_LENGTH = 4000;

export function normalizeSpeakText(text: string): string {
  const normalized = text.trim();
  if (!normalized) throw new Error("text is required");
  if (normalized.length > MAX_SPEAK_TEXT_LENGTH) {
    throw new Error("text must be 4000 characters or fewer");
  }
  return normalized;
}
