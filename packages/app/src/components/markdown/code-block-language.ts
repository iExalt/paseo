// Mirrors kLanguageNames in react-native-enriched-markdown's
// cpp/highlight/CodeBlockLanguages.cpp, which native code block headers use and
// JS cannot call. Keep it in sync when the library adds languages.
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  c: "C",
  cc: "C++",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  cxx: "C++",
  dockerfile: "Dockerfile",
  go: "Go",
  golang: "Go",
  graphql: "GraphQL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  objc: "Objective-C",
  objectivec: "Objective-C",
  php: "PHP",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
};

/** The language name a native code block header shows for a fence's language. */
export function codeBlockLanguageName(language: string | null | undefined): string {
  const lower = language?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!lower) return "";
  if (Object.hasOwn(LANGUAGE_NAMES, lower)) return LANGUAGE_NAMES[lower];
  return lower[0].toUpperCase() + lower.slice(1);
}
