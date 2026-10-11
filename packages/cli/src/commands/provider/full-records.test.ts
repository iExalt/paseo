import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  GetProvidersSnapshotResponseMessageSchema,
  ListProviderModelsResponseMessageSchema,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "provider-full-records-test",
    reconnect: { enabled: false },
  });
  const getProvidersSnapshot = vi.spyOn(client, "getProvidersSnapshot");
  const listProviderModels = vi.spyOn(client, "listProviderModels");
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValue(client);
  return { client, getProvidersSnapshot, listProviderModels };
}

describe("provider full record output", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { name: "empty provider snapshot", entries: [] },
    {
      name: "provider modes and catalog error details",
      entries: [
        {
          provider: "codex",
          label: "Codex CLI",
          description: "OpenAI coding agent",
          enabled: true,
          status: "ready",
          defaultModeId: "plan",
          modes: [
            {
              id: "plan",
              label: "Planning",
              description: "Read before writing",
              icon: "plan-icon",
              colorTier: "blue",
            },
          ],
        },
        {
          provider: "claude",
          label: "Claude Code",
          description: "Anthropic coding agent",
          enabled: false,
          status: "error",
          error: "catalog unavailable",
          modes: [],
        },
      ],
    },
  ])("preserves $name in full JSON while legacy output remains an array", async ({ entries }) => {
    const { client, getProvidersSnapshot } = createClient();
    getProvidersSnapshot.mockResolvedValue(
      GetProvidersSnapshotResponseMessageSchema.parse({
        type: "get_providers_snapshot_response",
        payload: {
          entries,
          generatedAt: "2026-10-10T00:00:00.000Z",
          requestId: "providers-test",
        },
      }).payload,
    );

    const full = await runLsCommand({ daemonTarget, full: true }, new Command());
    expect(full.type).toBe("single");
    if (full.type !== "single") throw new Error("Expected full provider output");
    expect(full.data).toEqual({
      providers: entries.map((entry) => ({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        description: entry.description ?? "",
        enabled: entry.enabled,
        modes: entry.modes ?? [],
        status: entry.status === "ready" ? "available" : entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      })),
    });

    const legacy = await runLsCommand({ daemonTarget }, new Command());
    expect(legacy.type).toBe("list");
    if (legacy.type !== "list") throw new Error("Expected legacy provider list output");
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "empty model catalog",
      models: [],
      error: null,
    },
    {
      name: "complete model metadata and thinking options",
      models: [
        {
          provider: "codex",
          id: "gpt-test",
          aliases: ["gpt-latest"],
          isSelectable: true,
          label: "GPT Test",
          description: "Model description",
          isDefault: true,
          metadata: { family: "gpt", region: "global" },
          contextWindowMaxTokens: 128000,
          thinkingOptions: [
            {
              id: "high",
              label: "High",
              description: "More reasoning",
              isDefault: true,
              metadata: { effort: 3 },
            },
          ],
          defaultThinkingOptionId: "high",
        },
      ],
      error: null,
    },
  ])("preserves $name in full JSON and legacy array output", async ({ models, error }) => {
    const { client, listProviderModels } = createClient();
    listProviderModels.mockResolvedValue(
      ListProviderModelsResponseMessageSchema.parse({
        type: "list_provider_models_response",
        payload: {
          provider: "codex",
          models,
          error,
          fetchedAt: "2026-10-10T00:00:00.000Z",
          requestId: "models-test",
        },
      }).payload,
    );

    const full = await runModelsCommand("codex", { daemonTarget, full: true }, new Command());
    expect(full.type).toBe("single");
    if (full.type !== "single") throw new Error("Expected full model output");
    expect(full.data).toEqual({ provider: "codex", models });

    const legacy = await runModelsCommand("codex", { daemonTarget }, new Command());
    expect(legacy.type).toBe("list");
    if (legacy.type !== "list") throw new Error("Expected legacy model list output");
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("preserves provider model catalog errors", async () => {
    const { listProviderModels } = createClient();
    listProviderModels.mockResolvedValue(
      ListProviderModelsResponseMessageSchema.parse({
        type: "list_provider_models_response",
        payload: {
          provider: "codex",
          error: "catalog unavailable",
          fetchedAt: "2026-10-10T00:00:00.000Z",
          requestId: "models-error-test",
        },
      }).payload,
    );

    await expect(
      runModelsCommand("codex", { daemonTarget, full: true }, new Command()),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Failed to fetch models for codex: catalog unavailable",
    });
  });
});
