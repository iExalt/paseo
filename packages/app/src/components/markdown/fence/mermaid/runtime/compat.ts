// The build runs this bootstrap before loading any Mermaid modules.
globalThis.structuredClone ??= (value) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

// Mermaid 12's dependencies use these ES2024 APIs. They run inside the diagram frame;
// older WebViews lack the native implementations even after syntax transpilation.
Object.groupBy ??= <T, K extends PropertyKey>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => K,
): Partial<Record<K, T[]>> => {
  const groups: Partial<Record<K, T[]>> = Object.create(null);
  let index = 0;
  for (const item of items) {
    const key = keySelector(item, index++);
    (groups[key] ??= []).push(item);
  }
  return groups;
};

URL.canParse ??= (input, base) => {
  try {
    return Boolean(new URL(input, base));
  } catch {
    return false;
  }
};
