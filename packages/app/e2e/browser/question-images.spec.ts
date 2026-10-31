import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { encodeDeterministicPng } from "../support/helpers/assistant-images";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { waitForQuestionPrompt } from "../support/helpers/questions";

// The mock's "with images" seed names these files relative to the agent cwd.
const RELATIVE_IMAGES = [
  { file: "hero.png", alt: "Hero banner", width: 300, height: 600 },
  { file: "blue.png", alt: "Blue swatch", width: 48, height: 48 },
  { file: "green.png", alt: "Green swatch", width: 48, height: 48 },
] as const;
const QUESTION_IMAGE_MAX_HEIGHT = 240;

async function writePng(filePath: string, width: number, height: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, encodeDeterministicPng(width, height));
}

async function expectImageLoaded(card: Locator, alt: string) {
  const image = card.locator(`img[alt="${alt}"]`);
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0 && !element.src.startsWith("data:"),
      ),
    )
    .toBe(true);
  return image;
}

async function openImageQuestion(page: Page, input: { cwdSubdir?: string }) {
  await page.context().route("https://example.com/remote.png", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: encodeDeterministicPng(48, 48),
    }),
  );
  const outsideDir = await mkdtemp(path.join(tmpdir(), "question-images-outside-"));
  const outsidePath = path.join(outsideDir, "outside.png");
  await writePng(outsidePath, 48, 48);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "question-images-",
    title: "Question images e2e",
    cwdSubdir: input.cwdSubdir,
    initialPrompt: `Emit synthetic questions with images. Outside image: ${outsidePath}`,
  });
  for (const image of RELATIVE_IMAGES) {
    await writePng(
      path.join(session.cwd, "question-images", image.file),
      image.width,
      image.height,
    );
  }
  await openAgentRoute(page, session);
  await waitForQuestionPrompt(page, 120_000);
  return {
    card: page.getByTestId("question-form-card").first(),
    cleanup: async () => {
      await session.cleanup();
      await rm(outsideDir, { recursive: true, force: true });
    },
  };
}

test.describe("Question images", () => {
  test("question text and descriptions show workspace, absolute and remote images", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { card, cleanup } = await openImageQuestion(page, {});
    try {
      const hero = await expectImageLoaded(card, "Hero banner");
      for (const alt of ["Blue swatch", "Green swatch", "Remote swatch", "Outside swatch"]) {
        await expectImageLoaded(card, alt);
      }
      // The 300x600 hero is taller than the dialog cap; it shrinks without stretching.
      const heroBox = await hero.boundingBox();
      expect(heroBox?.height).toBeLessThanOrEqual(QUESTION_IMAGE_MAX_HEIGHT);
      expect((heroBox?.width ?? 0) / (heroBox?.height ?? 1)).toBeCloseTo(0.5, 1);
      // A missing file falls back to its alt text, not an empty box.
      // A failed read reaches "unavailable" only after the image query's retries (about 7 s).
      await expect(card.getByText("Missing swatch")).toBeVisible({ timeout: 30_000 });
      await expect(card.locator('img[alt="Missing swatch"]')).toHaveCount(0);

      // A description image opens the lightbox; it never answers the question.
      await card.locator('img[alt="Green swatch"]').click();
      await expect(page.getByTestId("attachment-lightbox")).toBeVisible();
      await expect(card.getByRole("radio", { name: /Green/ })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    } finally {
      await cleanup();
    }
  });

  test("relative images resolve against the agent cwd, not the workspace root", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { card, cleanup } = await openImageQuestion(page, { cwdSubdir: "packages/site" });
    try {
      await expectImageLoaded(card, "Hero banner");
      await expectImageLoaded(card, "Green swatch");
    } finally {
      await cleanup();
    }
  });
});
