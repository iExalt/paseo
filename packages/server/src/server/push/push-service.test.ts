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

  test("bounds preview bytes in the actual per-device Expo envelope", async () => {
    respond({ tickets: [{ status: "ok", id: "ticket" }] });
    const service = new PushService(logger, () => undefined);
    await service.sendOne("ExponentPushToken[" + "x".repeat(200) + "]", {
      title: "Finished",
      body: "A message",
      data: {
        serverId: "host",
        agentId: "agent",
        preview: {
          v: 1,
          kind: "assistant",
          epoch: "epoch",
          seqStart: 1,
          seqEnd: 9,
          timestamp: "2026-11-06T00:00:00.000Z",
          text: '🙂漢字"\\\n'.repeat(1000),
          truncated: false,
        },
      },
    });
    const request = vi.mocked(fetch).mock.calls[0]![1]!;
    const messages = JSON.parse(String(request.body));
    expect(messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(messages[0]), "utf8")).toBeLessThanOrEqual(4000);
    expect(messages[0].data.preview.text.length).toBeGreaterThan(0);
    expect(messages[0].data.preview.truncated).toBe(true);
  });
});

describe("ordinary attention push tags", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("uses a unique tag per alert, shared across its recipients, while leaving test pushes alone", async () => {
    respond({ tickets: [{ status: "ok" }, { status: "ok" }] });
    const service = new PushService(logger, () => undefined);
    const payload = {
      title: "Question",
      body: "Pending",
      data: { serverId: "host", agentId: "agent", reason: "permission" },
    };
    await service.sendPush(["token-a", "token-b"], payload);
    await service.sendPush(["token-a"], payload);
    const calls = vi.mocked(fetch).mock.calls;
    const first = JSON.parse(String(calls[0]![1]!.body));
    const second = JSON.parse(String(calls[1]![1]!.body));
    expect(first[0].tag).toBe(first[1].tag);
    expect(first[0].tag).toMatch(/^paseo-agent-v1:/);
    expect(second[0].tag).not.toBe(first[0].tag);
    await service.sendPush(["token-a"], {
      title: "Test",
      body: "Test",
      data: { kind: "push_test" },
    });
    const testPush = JSON.parse(String(vi.mocked(fetch).mock.calls[2]![1]!.body));
    expect(testPush[0]).not.toHaveProperty("tag");
    await service.sendPush(["token-a"], {
      title: "Terminal",
      body: "Done",
      data: { serverId: "host", terminalId: "term" },
    });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[3]![1]!.body))[0]).not.toHaveProperty(
      "tag",
    );
    await service.sendPush(["token-a"], {
      ...payload,
      data: { ...payload.data, agentId: "x".repeat(1025) },
    });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[4]![1]!.body))[0]).not.toHaveProperty(
      "tag",
    );
  });

  test("preserves the original bounded preview when a tag does not fit", async () => {
    respond({ tickets: [{ status: "ok" }] });
    const service = new PushService(logger, () => undefined);
    await service.sendPush(["token-a"], {
      title: "Finished",
      body: "Body",
      data: {
        serverId: "host",
        agentId: "agent",
        reason: "finished",
        preview: {
          v: 1,
          kind: "assistant",
          epoch: "epoch",
          seqStart: 1,
          seqEnd: 2,
          timestamp: "2026-11-06T00:00:00.000Z",
          text: "漢🙂".repeat(2000),
          truncated: false,
        },
      },
    });
    const messages = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body));
    expect(messages[0]).not.toHaveProperty("tag");
    expect(messages[0].data.preview.text.length).toBeGreaterThan(0);
    expect(messages[0].data.preview.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(messages[0]), "utf8")).toBeLessThanOrEqual(4000);
  });

  test("preserves a near-limit alert without a preview by omitting the tag", async () => {
    respond({ tickets: [{ status: "ok" }] });
    const service = new PushService(logger, () => undefined);
    const title = "x".repeat(3830);
    const data = { serverId: "host", agentId: "agent", reason: "permission" };
    await service.sendPush(["token-a"], { title, body: "body", data });
    const message = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))[0];
    expect(message).not.toHaveProperty("tag");
    expect(message.title).toBe(title);
    expect(message.body).toBe("body");
    expect(message.data).toEqual(data);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(4000);
  });
});

describe("managed lifecycle transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  test("actual Expo HTTP payload stays data-only and distinguishes alert/cancellation priority", async () => {
    respond({ tickets: [{ status: "ok", id: "accepted" }] });
    const service = new PushService(logger, () => undefined);
    const issuedAt = Date.now();
    const episode = {
      agentId: "agent",
      lane: "question" as const,
      episodeId: "22222222-2222-4222-8222-222222222222",
      issuedAt,
      expiresAt: issuedAt + 60000,
    };
    const subscriptions = [
      { token: "ExponentPushToken[test]", registrationId: "11111111-1111-4111-8111-111111111111" },
    ];
    await service.sendLifecycle(subscriptions, "host", episode, {
      title: "Question",
      body: "Allow?",
      data: { reason: "permission" },
    });
    await service.sendLifecycle(subscriptions, "host", episode);
    const calls = vi.mocked(fetch).mock.calls;
    const alert = JSON.parse(String(calls[0]![1]!.body))[0];
    const resolve = JSON.parse(String(calls[1]![1]!.body))[0];
    for (const message of [alert, resolve]) {
      expect(message).not.toHaveProperty("title");
      expect(message).not.toHaveProperty("body");
      expect(message).not.toHaveProperty("sound");
      expect(message.data).not.toHaveProperty("title");
      expect(message.data).not.toHaveProperty("message");
      expect(message.data.paseoLifecycle).toMatchObject(episode);
    }
    expect(alert.priority).toBe("high");
    expect(resolve.priority).toBe("normal");
    expect(resolve.ttl).toBe(86400);
    expect(resolve.data.paseoLifecycle.operation).toBe("resolve");
  });
  test("resolution is not acknowledged when Expo rejects or omits its ticket", async () => {
    respond({ tickets: [] });
    const service = new PushService(logger, () => undefined);
    const issuedAt = Date.now();
    expect(
      await service.sendLifecycle(
        [{ token: "token", registrationId: "11111111-1111-4111-8111-111111111111" }],
        "host",
        {
          agentId: "agent",
          lane: "attention",
          episodeId: "22222222-2222-4222-8222-222222222222",
          issuedAt,
          expiresAt: issuedAt + 1,
        },
      ),
    ).toBe(false);
  });
});

test("managed HTTP transport bounds existing chat preview without losing identity or native safety", async () => {
  respond({ tickets: [{ status: "ok", id: "ticket" }] });
  try {
    const issuedAt = Date.now();
    const episode = {
      agentId: "agent",
      lane: "attention" as const,
      episodeId: "22222222-2222-4222-8222-222222222222",
      issuedAt,
      expiresAt: issuedAt + 60000,
    };
    const preview = {
      v: 1,
      kind: "assistant",
      epoch: "epoch",
      seqStart: 12,
      seqEnd: 14,
      timestamp: "2026-11-11T00:00:00.000Z",
      text: "🌋".repeat(1900),
      truncated: false,
    };
    await new PushService(logger, () => undefined).sendLifecycle(
      [{ token: "token", registrationId: "11111111-1111-4111-8111-111111111111" }],
      "host",
      episode,
      { title: "Finished", body: "B".repeat(1000), data: { reason: "finished", preview } },
    );
    const message = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))[0];
    expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(4000);
    expect(message.data.paseoLifecycle).toMatchObject(episode);
    expect(message.data.preview).toMatchObject({
      v: 1,
      kind: "assistant",
      epoch: "epoch",
      seqStart: 12,
      seqEnd: 14,
      timestamp: preview.timestamp,
      truncated: true,
    });
    expect(message.data.preview.text.length).toBeLessThan(preview.text.length);
    expect(message).not.toHaveProperty("title");
    expect(message).not.toHaveProperty("body");
    expect(message.data).not.toHaveProperty("title");
    expect(message.data).not.toHaveProperty("message");
  } finally {
    vi.unstubAllGlobals();
  }
});
