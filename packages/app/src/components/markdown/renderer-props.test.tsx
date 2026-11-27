/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./renderer";

const nativeMarkdown = vi.hoisted(() =>
  vi.fn((_props: { markdown: string; enableCodeBlockWrapToggle?: boolean }) => null),
);

vi.mock("react-native-enriched-markdown", () => ({
  EnrichedMarkdownText: nativeMarkdown,
}));

it("keeps fenced code blocks copy-only in the shared Markdown renderer", () => {
  const markdown = "```ts\nconst count = 1;\n```";
  const queryClient = new QueryClient();

  render(
    <QueryClientProvider client={queryClient}>
      <MarkdownRenderer text={markdown} />
    </QueryClientProvider>,
  );

  expect(nativeMarkdown.mock.calls.map(([props]) => props)).toContainEqual(
    expect.objectContaining({ markdown, enableCodeBlockWrapToggle: false }),
  );
});
