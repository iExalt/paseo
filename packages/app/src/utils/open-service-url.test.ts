import { describe, expect, it } from "vitest";
import type { ServiceUrlBehavior } from "@/hooks/use-settings";
import { openServiceUrl, type OpenServiceUrlEnvironment } from "./open-service-url";

const SERVICE_URL = "https://web--main--paseo.example.com";

function createHarness(input: {
  behavior: ServiceUrlBehavior;
  answer?: { choice: "in-app" | "external"; remember: boolean };
}) {
  const calls: string[] = [];
  const environment: OpenServiceUrlEnvironment = {
    openExternal: async (url) => {
      calls.push(`external ${url}`);
    },
    loadBehavior: async () => input.behavior,
    persistBehavior: async (behavior) => {
      calls.push(`persist ${behavior}`);
    },
    ask: async (url) => {
      calls.push(`ask ${url}`);
      return input.answer ?? { choice: "external", remember: false };
    },
  };
  const openInApp = (url: string) => {
    calls.push(`tab ${url}`);
  };
  return { calls, environment, openInApp };
}

describe("openServiceUrl", () => {
  it("opens externally without asking when no browser tab opener is supplied", async () => {
    const { calls, environment } = createHarness({ behavior: "in-app" });
    await openServiceUrl(SERVICE_URL, { environment });
    expect(calls).toEqual([`external ${SERVICE_URL}`]);
  });

  it("follows a saved choice without asking", async () => {
    const inApp = createHarness({ behavior: "in-app" });
    await openServiceUrl(SERVICE_URL, {
      environment: inApp.environment,
      openInApp: inApp.openInApp,
    });
    expect(inApp.calls).toEqual([`tab ${SERVICE_URL}`]);

    const external = createHarness({ behavior: "external" });
    await openServiceUrl(SERVICE_URL, {
      environment: external.environment,
      openInApp: external.openInApp,
    });
    expect(external.calls).toEqual([`external ${SERVICE_URL}`]);
  });

  it("asks, and saves the answer only when the user chose not to be asked again", async () => {
    const once = createHarness({ behavior: "ask", answer: { choice: "in-app", remember: false } });
    await openServiceUrl(SERVICE_URL, { environment: once.environment, openInApp: once.openInApp });
    expect(once.calls).toEqual([`ask ${SERVICE_URL}`, `tab ${SERVICE_URL}`]);

    const always = createHarness({
      behavior: "ask",
      answer: { choice: "external", remember: true },
    });
    await openServiceUrl(SERVICE_URL, {
      environment: always.environment,
      openInApp: always.openInApp,
    });
    expect(always.calls).toEqual([
      `ask ${SERVICE_URL}`,
      "persist external",
      `external ${SERVICE_URL}`,
    ]);
  });
});
