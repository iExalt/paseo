import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

const logger = {
  child: () => logger,
  error: () => undefined,
} as unknown as pino.Logger;

function respond(init: { status?: number; tickets?: unknown[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      init.status
        ? new Response("", { status: init.status, statusText: "Bad Gateway" })
        : Response.json({ data: init.tickets }),
    ),
  );
}

describe("PushService.sendOne", () => {
  afterEach(() => vi.unstubAllGlobals());
  const payload = { title: "Paseo", body: "Test", data: { kind: "push_test" } };

  test("reports Expo's ticket, and an unregistered device loses its token as for any push", async () => {
    const revoked: string[] = [];
    const service = new PushService(logger, (token) => revoked.push(token));

    respond({ tickets: [{ status: "ok", id: "ticket" }] });
    expect(await service.sendOne("ExponentPushToken[a]", payload)).toEqual({ outcome: "accepted" });

    respond({
      tickets: [
        { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
      ],
    });
    expect(await service.sendOne("ExponentPushToken[a]", payload)).toEqual({
      outcome: "failed",
      error: "not registered",
    });
    expect(revoked).toEqual(["ExponentPushToken[a]"]);
  });

  test("reports an Expo API error instead of throwing", async () => {
    const service = new PushService(logger, () => undefined);
    respond({ status: 502 });
    expect(await service.sendOne("ExponentPushToken[a]", payload)).toEqual({
      outcome: "failed",
      error: "Expo push API error 502 Bad Gateway",
    });
  });
});
