import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createPushNotifications } from "./index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device stops receiving notifications after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ subscriptions: [] });
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });
});

test("only capable Android devices switch delivery ownership, without falling back on closed episodes", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-routing-"));
  const deliveries: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ status: "ok", id: "ticket" }] })),
  );
  try {
    const push = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "tokens.json"),
      deliver: async (tokens) => {
        deliveries.push(tokens);
      },
    });
    push.renew("legacy");
    push.renew("managed", "11111111-1111-4111-8111-111111111111");
    const payload = {
      title: "Finished",
      body: "Done",
      data: { serverId: "host", agentId: "agent", reason: "finished" },
    };
    await push.send(payload);
    expect(deliveries).toEqual([["legacy"]]);
    expect(fetch).not.toHaveBeenCalled();
    const issuedAt = Date.now();
    await push.send({
      ...payload,
      lifecycle: {
        agentId: "agent",
        lane: "attention",
        episodeId: "22222222-2222-4222-8222-222222222222",
        issuedAt,
        expiresAt: issuedAt + 60000,
      },
    });
    expect(deliveries).toEqual([["legacy"], ["legacy"]]);
    const messages = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body));
    expect(messages[0].to).toBe("managed");
    expect(messages[0]).not.toHaveProperty("title");
  } finally {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});
