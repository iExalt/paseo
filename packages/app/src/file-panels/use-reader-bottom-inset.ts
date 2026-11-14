  // Keep the hook call out of the returned literal: React Compiler memoizes the
  // literal on first render, which skipped useRef on later renders and crashed the
  // Markdown preview with "Should have a queue".
  const ref = useRef<View>(null);
  return { ref, onLayout: undefined, bottomPadding: 0 };
