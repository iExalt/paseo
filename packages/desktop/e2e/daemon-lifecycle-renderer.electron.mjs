import { openSync, closeSync } from "node:fs";
import { warmMetro } from "../../app/e2e/support/metro-warmup.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";
import { _electron as electron, expect } from "playwright/test";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";

// Run under a private Xvfb display. Dialog answers stay in this test process;
// daemon operations still cross the real preload and IPC.
export async function verifyAttachedDaemonControls({ repo, root, env, home, port, instance }) {
  if (!process.env.DISPLAY)
    throw new Error("Renderer lifecycle QA requires a private Xvfb display");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const metroPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const metroLog = openSync(path.join(root, "metro.log"), "w");
  const metro = spawn(
    process.execPath,
    [
      path.join(repo, "node_modules/expo/bin/cli"),
      "start",
      "--web",
      "--port",
      String(metroPort),
      "--offline",
    ],
    {
      cwd: path.join(repo, "packages/app"),
      detached: true,
      stdio: ["ignore", metroLog, metroLog],
      env: {
        ...env,
        EXPO_NO_DOTENV: "1",
        EXPO_UNSTABLE_HEADLESS: "1",
        CI: "1",
        PASEO_WEB_PLATFORM: "electron",
        EXPO_PUBLIC_LOCAL_DAEMON: `127.0.0.1:${port}`,
      },
    },
  );
  closeSync(metroLog);
  let desktop;
  let page;
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    // /status means Metro is listening; the app bundle may still need a cold compile.
    await warmMetro(metroPort);
    const launchDesktop = () =>
      electron.launch({
        args: [path.join(repo, "packages/desktop/dist/main.js"), "--no-sandbox"],
        env: {
          ...env,
          EXPO_DEV_URL: `http://127.0.0.1:${metroPort}`,
          PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
          PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "renderer-user-data"),
        },
      });
    desktop = await launchDesktop();
    page = await desktop.firstWindow();
    page.on("pageerror", (error) => console.log("Renderer error:", error.message));
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 90_000 });
    await page.getByRole("button", { name: "Enable built-in daemon", exact: true }).click();
    await expect(page.getByText("Attached to an existing daemon", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Removes localhost from this device and stops the built-in daemon", {
        exact: true,
      }),
    ).toBeHidden();
    await page
      .getByText("Attached to an existing daemon", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, "attached-daemon.png") });

    await desktop.evaluate(({ dialog }) => {
      globalThis.testDialogs = { original: dialog.showMessageBox, prompts: [], answers: [] };
      dialog.showMessageBox = async (_window, options) => {
        globalThis.testDialogs.prompts.push(options);
        const answer = globalThis.testDialogs.answers.shift();
        if (!answer) throw new Error("Unexpected native message box");
        return answer;
      };
    });

    async function answerDialog(title, response, action) {
      await desktop.evaluate((_, answer) => globalThis.testDialogs.answers.push(answer), {
        response,
        checkboxChecked: false,
      });
      await action();
      await expect
        .poll(() => desktop.evaluate(() => globalThis.testDialogs.prompts.length))
        .toBe(1);
      const prompt = await desktop.evaluate(() => globalThis.testDialogs.prompts.shift());
      expect(prompt?.title).toBe(title);
      expect(prompt?.message).toBeTruthy();
      console.log("Dialog prompt:", JSON.stringify(prompt));
    }

    // Exercise the checkbox variant through the same renderer bridge.
    await desktop.evaluate(() =>
      globalThis.testDialogs.answers.push({ response: 1, checkboxChecked: true }),
    );
    const checkbox = await page.evaluate(() =>
      window.paseoDesktop.dialog.askWithCheckbox("Remember this?", {
        title: "Checkbox test",
        checkboxLabel: "Remember",
      }),
    );
    expect(checkbox).toEqual({ confirmed: true, dontAskAgain: true });
    const checkboxPrompt = await desktop.evaluate(() => globalThis.testDialogs.prompts.shift());
    console.log("Dialog prompt:", JSON.stringify(checkboxPrompt));
    expect(checkboxPrompt).toMatchObject({
      title: "Checkbox test",
      message: "Remember this?",
      checkboxLabel: "Remember",
    });

    const management = page.getByRole("switch", { name: "Manage built-in daemon" });
    await answerDialog("Pause built-in daemon", 1, () => management.click());
    await expect(management).not.toBeChecked();
    expect((await readDaemonInstance(home)).pid).toBe(instance.pid);

    await answerDialog("Stop local daemon?", 0, () =>
      page.getByRole("button", { name: "Stop daemon", exact: true }).click(),
    );
    await expect(page.getByRole("button", { name: "Stop daemon", exact: true })).toBeEnabled();
    expect(await readDaemonInstance(home)).toMatchObject({
      pid: instance.pid,
      startedAt: instance.startedAt,
    });

    await answerDialog("Stop local daemon?", 1, () =>
      page.getByRole("button", { name: "Stop daemon", exact: true }).click(),
    );
    await expect.poll(() => readDaemonInstance(home), { timeout: 20_000 }).toBeNull();
    await expect(page.getByRole("button", { name: "Stop daemon", exact: true })).toBeHidden();
    await page.screenshot({ path: path.join(root, "attached-daemon-stopped.png") });
    console.log(
      "PASS: real Desktop renderer pauses management without stopping an attached daemon, then confirms and stops that instance.",
    );

    const appearance = () =>
      page
        .locator('[data-testid="settings-sidebar"]:visible')
        .getByRole("button", { name: "Appearance", exact: true });
    await appearance().click();
    await page.getByLabel("Theme: System", { exact: true }).click();
    await page.getByText("Light", { exact: true }).click();
    await expect(page.getByLabel("Theme: Light", { exact: true })).toBeVisible();
    const fontSize = page.getByLabel("Interface font size");
    await fontSize.fill("17");
    await fontSize.press("Tab");
    const savedSettings = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}"));
    await expect
      .poll(async () => {
        const saved = await savedSettings();
        return { theme: saved.theme, uiBaseFontSize: saved.uiBaseFontSize };
      })
      .toEqual({ theme: "light", uiBaseFontSize: 17 });
    await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCSS(
      "background-color",
      "rgb(244, 244, 245)",
    );
    await page.screenshot({ path: path.join(root, "settings-before-quit.png") });
    console.log(
      "Settings before quit:",
      JSON.stringify(await savedSettings()),
      "pid",
      desktop.process().pid,
    );

    const exited = once(desktop.process(), "exit", { signal: AbortSignal.timeout(20_000) });
    await desktop.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    expect(await exited).toEqual([0, null]);
    desktop = null;
    page = null;

    desktop = await launchDesktop();
    page = await desktop.firstWindow();
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 90_000 });
    await appearance().click();
    await expect(page.getByLabel("Theme: Light", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Interface font size")).toHaveValue("17");
    await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCSS(
      "background-color",
      "rgb(244, 244, 245)",
    );
    await expect
      .poll(async () => {
        const saved = await savedSettings();
        return { theme: saved.theme, uiBaseFontSize: saved.uiBaseFontSize };
      })
      .toEqual({ theme: "light", uiBaseFontSize: 17 });
    await page.screenshot({ path: path.join(root, "settings-after-quit.png") });
    console.log(
      "Settings after relaunch:",
      JSON.stringify(await savedSettings()),
      "pid",
      desktop.process().pid,
    );
    console.log(
      "PASS: isolated Electron retains appearance settings across app.quit and relaunch.",
    );

    const fontSizeBeforeSignal = page.getByLabel("Interface font size");
    await fontSizeBeforeSignal.fill("19");
    await fontSizeBeforeSignal.press("Tab");
    await expect(page.getByLabel("Interface font size")).toHaveValue("19");
    await expect(page.getByText("Theme", { exact: true }).first()).toHaveCSS("font-size", "16px");
    const signalExit = once(desktop.process(), "exit", { signal: AbortSignal.timeout(20_000) });
    const signalPid = desktop.process().pid;
    if (!desktop.process().kill("SIGTERM"))
      throw new Error("Could not signal test Electron process");
    expect(await signalExit).toEqual([0, null]);
    desktop = null;
    page = null;

    desktop = await launchDesktop();
    page = await desktop.firstWindow();
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 90_000 });
    await appearance().click();
    await expect(page.getByLabel("Theme: Light", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Interface font size")).toHaveValue("19");
    await expect
      .poll(async () => {
        const saved = await savedSettings();
        return { theme: saved.theme, uiBaseFontSize: saved.uiBaseFontSize };
      })
      .toEqual({ theme: "light", uiBaseFontSize: 19 });
    await page.screenshot({ path: path.join(root, "settings-after-sigterm.png") });
    console.log(
      "Settings after SIGTERM:",
      JSON.stringify(await savedSettings()),
      "signalled pid",
      signalPid,
      "new pid",
      desktop.process().pid,
    );
    console.log(
      "PASS: isolated Electron retains the UI-confirmed setting across SIGTERM and relaunch.",
    );
  } catch (error) {
    if (page) {
      console.log(
        "Renderer state:",
        await page
          .locator("body")
          .innerText()
          .catch(() => "closed"),
      );
      await page.screenshot({ path: path.join(root, "renderer-failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    if (desktop) {
      const exited = once(desktop.process(), "exit");
      await desktop
        .evaluate(({ app, dialog }) => {
          if (globalThis.testDialogs) dialog.showMessageBox = globalThis.testDialogs.original;
          app.exit(0);
        })
        .catch(() => {});
      await exited;
    }
    if (metro.exitCode === null) {
      const exited = once(metro, "exit");
      process.kill(-metro.pid, "SIGTERM");
      await exited;
    }
  }
}
