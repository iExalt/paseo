import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { encodeDeterministicPng } from "../support/helpers/assistant-images";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { waitForQuestionPrompt } from "../support/helpers/questions";

interface ImageState {
  alt: string;
  loaded: boolean;
  width: number;
  height: number;
}

async function writePng(filePath: string, width: number, height: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, encodeDeterministicPng(width, height));
}

async function imageStates(card: Locator): Promise<ImageState[]> {
  return card.locator("img").evaluateAll((images) =>
    images.map((element) => {
      const image = element as HTMLImageElement;
      const box = image.getBoundingClientRect();
      return {
        alt: image.alt,
        loaded: image.complete && image.naturalWidth > 0 && !image.src.startsWith("data:"),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }),
  );
}

async function openImageQuestion(page: Page, input: { cwdSubdir?: string }) {
  await page
    .context()
    .route("https://example.com/remote.png", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: encodeDeterministicPng(48, 48) }),
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
  for (const [name, width, height] of [
    ["hero.png", 320, 160],
    ["blue.png", 48, 48],
    ["green.png", 48, 48],
    ["no-alt.png", 48, 48],
  ] as const) {
    await writePng(path.join(session.cwd, "question-images", name), width, height);
  }
  await openAgentRoute(page, session);
  await waitForQuestionPrompt(page, 120_000);
  const card = page.getByTestId("question-form-card").first();
  return {
    card,
    cleanup: async () => {
      await session.cleanup();
      await rm(outsideDir, { recursive: true, force: true });
    },
  };
}

test.describe("Question images (spike)", () => {
  for (const cwdSubdir of [undefined, "packages/site"]) {
    test(`records image states, cwd=${cwdSubdir ?? "repo root"}`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const { card, cleanup } = await openImageQuestion(page, { cwdSubdir });
      try {
        await page.waitForTimeout(5_000);
        const states = await imageStates(card);
        console.log(`SPIKE cwd=${cwdSubdir ?? "root"} ${JSON.stringify(states)}`);
        await card.screenshot({ path: testInfo.outputPath("card.png") });
        const green = card.getByRole("radio", { name: /Green/ });
        const greenImage = card.locator('img[alt="Green swatch"]');
        if ((await greenImage.count()) > 0) {
          await greenImage.click();
          await page.waitForTimeout(500);
          console.log(
            `SPIKE cwd=${cwdSubdir ?? "root"} green-click checked=${await green.getAttribute("aria-checked")} lightbox=${await page.getByTestId("attachment-lightbox").count()}`,
          );
          await page.screenshot({ path: testInfo.outputPath("after-click.png") });
        }
        expect(states.length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });
  }
});
