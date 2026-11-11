import { expect, it } from "vitest";
import { lifecycleTaskEvent } from "./lifecycle-payload";
const event = {
  v: 1,
  operation: "resolve",
  serverId: "host",
  agentId: "agent",
  lane: "question",
  registrationId: "11111111-1111-4111-8111-111111111111",
  episodeId: "22222222-2222-4222-8222-222222222222",
  issuedAt: 1,
  expiresAt: 1000,
};
it("reads the real Android serializer's Expo body JSON, retaining expired resolution", () => {
  expect(
    lifecycleTaskEvent(
      {
        notification: null,
        data: {
          body: JSON.stringify({ paseoLifecycle: event }),
          dataString: JSON.stringify({ paseoLifecycle: event }),
        },
      },
      2000,
    ),
  ).toEqual(event);
});
it("ignores notification taps, malformed JSON, ordinary pushes and wrong versions", () => {
  expect(
    lifecycleTaskEvent({ actionIdentifier: "default", data: { paseoLifecycle: event } }, 2),
  ).toBeNull();
  expect(lifecycleTaskEvent({ data: { dataString: "{" } }, 2)).toBeNull();
  expect(lifecycleTaskEvent({ data: { serverId: "host" } }, 2)).toBeNull();
  expect(lifecycleTaskEvent({ data: { paseoLifecycle: { ...event, v: 2 } } }, 2)).toBeNull();
});

it.each([
  { v: 1, kind: "permission", requestId: "request", text: "Allow?", truncated: false },
  {
    v: 1,
    kind: "assistant",
    epoch: "epoch",
    seqStart: 12,
    seqEnd: 14,
    timestamp: "2026-11-11T00:00:00.000Z",
    text: "Completed",
    truncated: true,
  },
])("preserves existing tap-preview anchors through the headless task: $kind", (preview) => {
  const alert = {
    ...event,
    operation: "alert",
    lane: preview.kind === "permission" ? "question" : "attention",
    reason: preview.kind === "permission" ? "permission" : "finished",
    preview: { title: "Title", body: "Body" },
  };
  const parsed = lifecycleTaskEvent(
    { data: { dataString: JSON.stringify({ paseoLifecycle: alert, preview }) } },
    2,
  );
  expect(parsed?.tapPreview).toEqual(preview);
  expect(parsed?.episodeId).toBe(event.episodeId);
});
it("invalid optional tap preview cannot invalidate a valid lifecycle alert or resolve", () => {
  const alert = {
    ...event,
    operation: "alert",
    reason: "permission",
    preview: { title: "Title", body: "Body" },
  };
  const parsed = lifecycleTaskEvent(
    { data: { paseoLifecycle: alert, preview: { kind: "bogus" } } },
    2,
  );
  expect(parsed?.operation).toBe("alert");
  expect(parsed).not.toHaveProperty("tapPreview");
  expect(
    lifecycleTaskEvent(
      {
        data: {
          paseoLifecycle: event,
          preview: { v: 1, kind: "permission", requestId: "id", text: "Read", truncated: true },
        },
      },
      2,
    ),
  ).not.toHaveProperty("tapPreview");
});
