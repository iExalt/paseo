const NON_HTTP_EXPLICIT_SCHEME_PATTERN = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeBrowserHttpUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  const explicitHttpUrl = /^https?:\/\//i.test(trimmed);
  if (!explicitHttpUrl && NON_HTTP_EXPLICIT_SCHEME_PATTERN.test(trimmed)) return null;
  const normalized = explicitHttpUrl ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}
