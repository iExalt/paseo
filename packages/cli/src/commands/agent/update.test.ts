import { describe, expect, it } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import { parseFeatureValues } from "../../utils/feature-values.js";
import {
  applyAgentChanges,
  parseAgentChanges,
  toAgentUpdateResult,
  type AgentMetadataChanges,
  type AgentUpdateClient,
} from "./update.js";

class RecordingAgentUpdateClient implements AgentUpdateClient {
  readonly calls: string[] = [];
  readonly metadataUpdates: Array<{ agentId: string; updates: AgentMetadataChanges }> = [];
  thinkingNotice: AgentProviderNotice | null = null;
  modeNotice: AgentProviderNotice | null = null;
  failAt: string | null = null;
  failure: unknown = null;

  constructor(private readonly supportsThinkingUpdate = true) {}

  getLastServerInfoMessage() {
    return { features: { agentThinkingUpdate: this.supportsThinkingUpdate } };
  }

  async updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void> {
    this.record("metadata");
    this.metadataUpdates.push({ agentId, updates });
  }

  async setAgentMode(_agentId: string, modeId: string): Promise<AgentProviderNotice | null> {
    this.record(`mode:${modeId}`);
    return this.modeNotice;
  }

  async setAgentModel(_agentId: string, modelId: string | null): Promise<void> {
    this.record(`model:${modelId}`);
  }

  async setAgentThinkingOption(
    _agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    this.record(`thinking:${thinkingOptionId}`);
    return this.thinkingNotice;
  }

  async setAgentFeature(_agentId: string, featureId: string, value: unknown): Promise<void> {
    this.record(`feature:${featureId}:${String(value)}`);
  }

  private record(call: string): void {
    this.calls.push(call);
    if (call === this.failAt) throw this.failure ?? new Error("provider rejected update");
  }
}

describe("parseFeatureValues", () => {
  it("preserves strings and parses booleans and null across repeated and comma-separated forms", () => {
    expect(
      parseFeatureValues(["fast_mode=true,reasoning=false", "service_tier=flex", "reset=null"]),
    ).toEqual({
      fast_mode: true,
      reasoning: false,
      service_tier: "flex",
      reset: null,
    });
  });

  it("supports string IDs that look like primitives and protects special object keys", () => {
    expect(
      parseFeatureValues(['choice="true"', '__proto__="null"', 'constructor="false"']),
    ).toEqual(
      Object.fromEntries([
        ["choice", "true"],
        ["__proto__", "null"],
        ["constructor", "false"],
      ]),
    );
  });

  it("splits commas and escaped quotes only outside quoted JSON strings", () => {
    expect(parseFeatureValues(['description="north, west"', 'quote="say \\\"hi\\\""'])).toEqual({
      description: "north, west",
      quote: 'say "hi"',
    });
  });

  it.each([
    ["missing equals", ["fast_mode"]],
    ["empty ID", [" =true"]],
    ["empty value", ["fast_mode=  "]],
    ["duplicate IDs", ["fast_mode=true", "fast_mode=false"]],
    [
      "duplicate IDs across repeated and comma-separated forms",
      ["fast_mode=true", "other=false,fast_mode=null"],
    ],
    ["malformed quoted values", ['tier="fast']],
  ])("rejects %s", (_name, values) => {
    expect(() => parseFeatureValues(values)).toThrow();
  });
});

describe("parseAgentChanges", () => {
  it("maps explicit clears and combines settings with metadata", () => {
    expect(
      parseAgentChanges({
        name: " New name ",
        label: ["team=platform"],
        mode: " plan ",
        clearModel: true,
        clearThinking: true,
        feature: ["fast_mode=true", "service_tier=flex"],
      }),
    ).toEqual({
      modeId: "plan",
      modelId: null,
      thinkingOptionId: null,
      features: { fast_mode: true, service_tier: "flex" },
      metadata: { name: "New name", labels: { team: "platform" } },
    });
  });

  it("preserves arbitrary JSON feature values in updates", () => {
    expect(
      parseAgentChanges({
        featuresJson: '{"choices":[1,"two",null],"nested":{"enabled":true}}',
      }),
    ).toEqual({
      features: { choices: [1, "two", null], nested: { enabled: true } },
    });
  });

  it("rejects conflicting value and clear options before any update starts", () => {
    expect(() => parseAgentChanges({ model: "gpt-5", clearModel: true })).toThrow(
      "--clear-model cannot be combined with --model",
    );
    expect(() => parseAgentChanges({ thinking: "high", clearThinking: true })).toThrow(
      "--clear-thinking cannot be combined with --thinking",
    );
  });
});

describe("applyAgentChanges", () => {
  it("applies runtime settings in MCP order, followed by features and metadata", async () => {
    const client = new RecordingAgentUpdateClient();

    await applyAgentChanges(client, "agent-1", {
      modeId: "plan",
      modelId: "gpt-5.4",
      thinkingOptionId: "high",
      features: { fast_mode: true, service_tier: "flex" },
      metadata: { name: "Updated", labels: { team: "platform" } },
    });

    expect(client.calls).toEqual([
      "mode:plan",
      "model:gpt-5.4",
      "thinking:high",
      "feature:fast_mode:true",
      "feature:service_tier:flex",
      "metadata",
    ]);
    expect(client.metadataUpdates).toEqual([
      {
        agentId: "agent-1",
        updates: { name: "Updated", labels: { team: "platform" } },
      },
    ]);
  });

  it("does not send empty metadata for a thinking-only change", async () => {
    const client = new RecordingAgentUpdateClient();

    await applyAgentChanges(client, "agent-1", { thinkingOptionId: "high" });

    expect(client.calls).toEqual(["thinking:high"]);
    expect(client.metadataUpdates).toEqual([]);
  });

  it("forwards explicit model and thinking clears as null", async () => {
    const client = new RecordingAgentUpdateClient();

    await applyAgentChanges(client, "agent-1", { modelId: null, thinkingOptionId: null });

    expect(client.calls).toEqual(["model:null", "thinking:null"]);
  });

  it("reports accepted and unattempted steps when a later operation fails", async () => {
    const client = new RecordingAgentUpdateClient();
    client.failAt = "model:null";

    await expect(
      applyAgentChanges(client, "agent-1", {
        modeId: "plan",
        modelId: null,
        thinkingOptionId: null,
        features: { fast_mode: true },
        metadata: { name: "Updated" },
      }),
    ).rejects.toMatchObject({
      code: "UPDATE_FAILED",
      message: "provider rejected update",
      details:
        "Failed step: model. Completed before failure: mode. Not attempted: thinking, feature fast_mode, metadata. Earlier accepted changes may remain; the failed step's outcome may be unknown if its response was lost.",
    });
    expect(client.calls).toEqual(["mode:plan", "model:null"]);
  });

  it("preserves typed transport codes and messages while reporting partial state", async () => {
    const client = new RecordingAgentUpdateClient();
    client.failAt = "model:gpt-5.4";
    client.failure = new DaemonConnectionError("Request timed out", "DAEMON_REQUEST_TIMEOUT");

    await expect(
      applyAgentChanges(client, "agent-1", {
        modeId: "plan",
        modelId: "gpt-5.4",
        metadata: { name: "Updated" },
      }),
    ).rejects.toMatchObject({
      code: "DAEMON_REQUEST_TIMEOUT",
      message: "Request timed out",
      details: expect.stringContaining("Failed step: model. Completed before failure: mode."),
    });
    expect(client.calls).toEqual(["mode:plan", "model:gpt-5.4"]);
  });

  it("checks thinking-update support before applying any requested change", async () => {
    const client = new RecordingAgentUpdateClient(false);

    await expect(
      applyAgentChanges(client, "agent-1", { modeId: "plan", thinkingOptionId: "high" }),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use agent thinking updates.",
    });
    expect(client.calls).toEqual([]);
  });

  it("returns the first provider notice while still completing later steps", async () => {
    const client = new RecordingAgentUpdateClient();
    client.modeNotice = { type: "warning", message: "Mode notice" };
    client.thinkingNotice = { type: "info", message: "Thinking notice" };

    const result = await applyAgentChanges(client, "agent-1", {
      modeId: "plan",
      thinkingOptionId: "high",
    });

    expect(client.calls).toEqual(["mode:plan", "thinking:high"]);
    expect(result.notice).toEqual({ type: "warning", message: "Mode notice" });
    expect(result.notices).toEqual([
      { type: "warning", message: "Mode notice" },
      { type: "info", message: "Thinking notice" },
    ]);
  });
});

describe("toAgentUpdateResult", () => {
  it("reports the current thinking option after a metadata update", () => {
    const notices = [
      { type: "warning" as const, message: "Mode notice" },
      { type: "info" as const, message: "Thinking notice" },
    ];
    const result = toAgentUpdateResult(
      {
        id: "agent-1",
        title: "Renamed agent",
        labels: { team: "platform" },
        effectiveThinkingOptionId: "high",
      },
      { notice: notices[0] ?? null, notices },
    );

    expect(result).toEqual({
      agentId: "agent-1",
      name: "Renamed agent",
      labels: "team=platform",
      thinkingOptionId: "high",
      noticeType: "warning",
      notice: "Mode notice",
      notices,
    });
  });
});
