import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import type { Locator } from "@playwright/test";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

const name = "Overseer heartbeat with a long descriptive name";
const targetTitle = "Overseer: check the maintenance backlog across all repositories";
const prompt =
  "Check the backlog and continue any approved work.\nReport blockers and the next step.";

async function expectNoDetailsOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId("schedule-details")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
}

async function activate(control: Locator, touch: boolean): Promise<void> {
  if (touch) await control.tap();
  else await control.click();
}

async function expectFeedbackVisible(feedback: Locator): Promise<void> {
  await expect
    .poll(() =>
      feedback.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    )
    .toBe(true);
}

async function failSecondRunResponse(page: Page): Promise<void> {
  let responses = 0;
  await page.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const data = JSON.parse(message.toString());
      if (data.message?.type === "schedule/run-once/response" && ++responses === 2) {
        const run = data.message.payload.schedule.runs.at(-1);
        run.status = "failed";
        run.error = "Heartbeat target unavailable";
        socket.send(JSON.stringify(data));
      } else socket.send(message);
    });
  });
}

for (const viewport of [
  { name: "phone", width: 375, height: 812, hasTouch: true },
  { name: "small desktop", width: 720, height: 600, hasTouch: false },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport, hasTouch: viewport.hasTouch });

    test("heartbeat details wrap and manual triggers reach the existing agent", async ({
      page,
    }) => {
      const workspace = await seedWorkspace({ repoPrefix: "heartbeat-details-", git: false });
      const client = workspace.client as unknown as DaemonClient;
      let scheduleId: string | undefined;
      try {
        const agent = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          title: targetTitle,
          model: "ten-second-stream",
          modeId: "load-test",
        });
        const created = await client.scheduleCreate({
          name,
          prompt,
          target: { type: "agent", agentId: agent.id },
          cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
          runOnCreate: false,
        });
        expect(created.error).toBeNull();
        expect(created.schedule).not.toBeNull();
        scheduleId = created.schedule!.id;
        await failSecondRunResponse(page);
        await page.goto(buildSchedulesRoute());
        const row = page.getByTestId(`schedule-row-${scheduleId}`);
        await expect(row).toContainText("Never run");
        await expect(row).toContainText("Next run");
        await activate(row, viewport.hasTouch);
        const details = page.getByTestId("schedule-details");
        await expect(details).toBeVisible();
        await expect(details).toContainText(name);
        await expect(details).toContainText(prompt);
        await expect(details).toContainText("Created");
        await expect(details).toContainText("Last run");
        await expect(details).toContainText("Next run");
        await expect(page.getByTestId("schedule-agent-target")).toHaveText(targetTitle);
        await expectNoDetailsOverflow(page);
        await activate(page.getByTestId("heartbeat-run-now"), viewport.hasTouch);
        await expect(details).toContainText("Heartbeat triggered.", { timeout: 30_000 });
        await expectFeedbackVisible(details.getByText("Heartbeat triggered.", { exact: true }));
        await expect
          .poll(async () => (await client.scheduleInspect({ id: scheduleId! })).schedule?.lastRunAt)
          .not.toBeNull();
        const inspected = (await client.scheduleInspect({ id: scheduleId })).schedule!;
        expect(inspected.runs.at(-1)).toMatchObject({ status: "succeeded", agentId: agent.id });
        expect(inspected.nextRunAt).toBe(created.schedule!.nextRunAt);
        await expect(details).not.toContainText("Never run");
        await activate(
          page.getByRole("button", { name: "Cancel", exact: true }),
          viewport.hasTouch,
        );
        await expect(details).not.toBeVisible();
        await activate(page.getByTestId(`schedule-kebab-${scheduleId}`), viewport.hasTouch);
        const previousRun = (await client.scheduleInspect({ id: scheduleId })).schedule!.lastRunAt;
        await activate(page.getByTestId(`schedule-menu-run-${scheduleId}`), viewport.hasTouch);
        await expect
          .poll(
            async () => (await client.scheduleInspect({ id: scheduleId! })).schedule?.lastRunAt,
            { timeout: 30_000 },
          )
          .not.toBe(previousRun);
        await expect(details).not.toBeVisible();
        await expect(row.getByRole("alert")).toHaveText("Heartbeat target unavailable");
      } finally {
        if (scheduleId) await client.scheduleDelete({ id: scheduleId });
        await workspace.cleanup();
      }
    });
  });
}
