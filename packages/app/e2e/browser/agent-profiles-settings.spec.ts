import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openModelPicker, closeModelPicker } from "../support/helpers/agent-profiles";
import { expect, test } from "../support/fixtures";
import {
  createAgentProfile,
  createAgentProfileFromEmptyState,
  editAgentProfile,
  expectAgentProfile,
  expectAgentProfileForm,
  expectAgentProfileOrder,
  expectAgentProfileTagsGone,
  expectHostAgentProfiles,
  expectNoAgentProfiles,
  moveAgentProfileUp,
  openAgentProfileSettings,
  removeAgentProfile,
  seedAgentProfiles,
  stageLegacyFavoritesForHostMigration,
} from "../support/helpers/agent-profiles";

function modelControlFitsViewport(element: Element): boolean {
  const control = element.getBoundingClientRect();
  return (
    control.left >= 0 &&
    control.right <= window.innerWidth &&
    control.top >= 0 &&
    control.bottom <= window.innerHeight &&
    control.width > 0 &&
    control.height > 0
  );
}

const MOCK_PROVIDER_LABEL = "Mock Load Test";

test.describe("Agent profiles settings", () => {
  test("hides unused models across reopen and search while retaining the selected model", async ({
    page,
  }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "model-visibility-",
      title: "Model visibility",
      model: "ten-second-stream",
    });
    try {
      await openAgentRoute(page, session);
      await openModelPicker(page);
      const picker = page.getByTestId("combobox-desktop-container");
      const search = picker.getByTestId(/^model-search(?:-all)?-input$/);
      const settings = page.getByTestId("provider-settings-sheet");
      await page.getByTestId("selector-header-settings-mock").click();
      await expect(settings).toBeVisible();
      await settings.getByTestId("provider-settings-search").fill("one-minute-stream");
      const unused = settings.getByTestId("model-visibility-one-minute-stream");
      await expect(unused).toBeChecked();
      await unused.click();
      await expect(unused).not.toBeChecked();
      await settings.getByTestId("provider-settings-search").fill("ten-second-stream");
      const selected = settings.getByTestId("model-visibility-ten-second-stream");
      await expect(selected).toBeVisible();
      await selected.click();
      await expect(selected).not.toBeChecked();
      await page.screenshot({ path: testInfo.outputPath("model-settings-hidden.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      const phoneSelected = page.getByRole("switch", {
        name: "Show Ten second stream in model pickers",
        exact: true,
      });
      await expect(phoneSelected).toBeVisible();
      await expect.poll(() => phoneSelected.evaluate(modelControlFitsViewport)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("model-settings-phone.png") });
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(selected).toBeVisible();
      await settings.getByLabel("Close", { exact: true }).click();
      await expect(settings).not.toBeVisible();
      await closeModelPicker(page);
      await openModelPicker(page);
      await search.fill("one-minute-stream");
      await expect(picker.getByText("No models match your search", { exact: true })).toBeVisible();
      await expect(picker.getByTestId("model-row-mock-one-minute-stream")).toHaveCount(0);
      await search.fill("ten-second-stream");
      await expect(picker.getByTestId("model-row-mock-ten-second-stream")).toBeVisible();
      await page.getByTestId("selector-header-settings-mock").click();
      await expect(settings).toBeVisible();
      await settings.getByTestId("provider-settings-search").fill("one-minute-stream");
      await expect(unused).not.toBeChecked();
      await unused.click();
      await expect(unused).toBeChecked();
      await settings.getByLabel("Close", { exact: true }).click();
      await expect(settings).not.toBeVisible();
      await search.fill("one-minute-stream");
      await expect(picker.getByTestId("model-row-mock-one-minute-stream")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("legacy model favourites migrate into provider-and-model-only host profiles", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([]);
    const migratedProfile = {
      id: "legacy_favorite:mock:one-minute-stream",
      name: "One minute stream",
      provider: "mock",
      model: "one-minute-stream",
    };

    try {
      await stageLegacyFavoritesForHostMigration(page, [
        { provider: "mock", modelId: "one-minute-stream" },
      ]);

      await expectHostAgentProfiles([migratedProfile]);
      await openAgentProfileSettings(page);
      await expectAgentProfile(page, {
        name: migratedProfile.name,
        tags: [MOCK_PROVIDER_LABEL, "One minute stream"],
      });
    } finally {
      await seed.restore();
    }
  });

  test("host owner creates, edits, reorders and removes agent profiles", async ({ page }) => {
    // The journey owns the list, so it starts from an empty one whatever the
    // worker ran before, and hands it back untouched.
    const seed = await seedAgentProfiles([]);

    try {
      await test.step("the section starts empty", async () => {
        await openAgentProfileSettings(page);
        await expectNoAgentProfiles(page);
      });

      await test.step("create a profile from the modal", async () => {
        await createAgentProfileFromEmptyState(page, {
          name: "UI work",
          provider: MOCK_PROVIDER_LABEL,
          model: "Ten second stream",
          thinking: "High",
          mode: "Approval test",
          notes: "Use for UI work — components, layout and design tokens.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "Ten second stream", "Approval test", "High"],
          notes: "Use for UI work — components, layout and design tokens.",
        });
      });

      await test.step("editing to a model without thinking levels drops the level", async () => {
        await editAgentProfile(page, "UI work", {
          model: "One minute stream",
          notes: "Now for quick checks.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "One minute stream", "Approval test"],
          notes: "Now for quick checks.",
        });
        await expectAgentProfileTagsGone(page, {
          name: "UI work",
          tags: ["Ten second stream", "High"],
        });
      });

      await test.step("the edit form reopens on what was stored", async () => {
        await expectAgentProfileForm(page, "UI work", {
          provider: MOCK_PROVIDER_LABEL,
          model: "One minute stream",
          mode: "Approval test",
          notes: "Now for quick checks.",
        });
      });

      await test.step("a second profile lands below the first", async () => {
        await createAgentProfile(page, {
          name: "Deep review",
          provider: MOCK_PROVIDER_LABEL,
          model: "Five minute stream",
        });
        await expectAgentProfileOrder(page, ["UI work", "Deep review"]);
      });

      await test.step("reorder puts the second profile on top", async () => {
        await moveAgentProfileUp(page, "Deep review");
        await expectAgentProfileOrder(page, ["Deep review", "UI work"]);
      });

      await test.step("removing a profile confirms by name", async () => {
        await removeAgentProfile(page, "UI work");
        await expectAgentProfileOrder(page, ["Deep review"]);
      });

      await test.step("removing the last profile returns the empty state", async () => {
        await removeAgentProfile(page, "Deep review");
        await expectNoAgentProfiles(page);
      });
    } finally {
      await seed.restore();
    }
  });
});
