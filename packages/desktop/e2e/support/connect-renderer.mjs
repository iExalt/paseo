import { chromium } from "playwright";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rendererPage(browser, origin) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      if (url.startsWith("devtools://") || url === "about:blank") continue;
      if (origin && !url.startsWith(origin)) continue;
      if (
        (await page
          .locator("#root > *")
          .count()
          .catch(() => 0)) > 0
      )
        return page;
    }
  }
  return null;
}

/**
 * Connects to a running Paseo desktop app over CDP and returns the page that shows the app.
 * `connectOverCDP` can succeed before the window exists, or list only DevTools and blank pages,
 * so this retries both until the renderer has drawn into #root.
 */
export async function connectToPaseoRenderer(cdpUrl, { origin, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let browser = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      browser ??= await chromium.connectOverCDP(cdpUrl);
      const page = await rendererPage(browser, origin);
      if (page) return { browser, page };
    } catch (error) {
      lastError = error;
      browser = null;
    }
    await delay(250);
  }
  throw new Error(
    `No Paseo renderer at ${cdpUrl} within ${timeoutMs} ms: ${lastError ?? "no page"}`,
  );
}
