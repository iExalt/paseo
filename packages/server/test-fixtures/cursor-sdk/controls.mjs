import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fast = "cursor_model_fast";
const reasoning = "cursor_model_reasoning_effort";
const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWkAAAAASUVORK5CYII=",
};
const fileText = "P7_FILE_REFERENCE";
const textAttachment = "P7_INLINE_REFERENCE";
const providerInstruction = "P7_PROVIDER_INSTRUCTION";
const userText =
  "<paseo_instructions>\nP7_LITERAL_USER_TEXT\n</paseo_instructions>\n\nRun the canary.";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (params = []) => params.toSorted((a, b) => a.id.localeCompare(b.id));

export function controlCatalog(model) {
  const parameters = [
    { id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] },
    {
      id: "reasoning_effort",
      displayName: "Reasoning",
      values: [{ value: "none" }, { value: "high" }],
    },
  ];
  const fastVariant = {
    displayName: "Fast",
    params: [
      { id: "fast", value: "true" },
      { id: "reasoning_effort", value: "none" },
    ],
  };
  const highVariant = {
    displayName: "High",
    params: [
      { id: "fast", value: "false" },
      { id: "reasoning_effort", value: "high" },
    ],
  };
  return [
    { id: "auto-smart", displayName: "Auto", aliases: ["default"] },
    { id: "default", displayName: "Auto", aliases: ["auto"] },
    {
      id: "fixture-high-only",
      displayName: "Fixture High Only",
      parameters: [{ id: "reasoning_effort", values: [{ value: "high" }] }],
    },
    {
      id: model,
      displayName: model,
      aliases: ["fixture-alias"],
      parameters,
      variants: [{ ...fastVariant, isDefault: true }, highVariant],
    },
    {
      id: "fixture-high",
      displayName: "Fixture High",
      parameters,
      variants: [fastVariant, { ...highVariant, isDefault: true }],
    },
  ];
}

export async function checkControls({
  backend,
  cli,
  listener,
  model,
  paseoHome,
  require,
  restart,
  workspace,
  workspaceId,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const { AgentAttachmentSchema } = await import(
    pathToFileURL(require.resolve("@getpaseo/protocol/messages"))
  );
  const inlineAttachment = AgentAttachmentSchema.parse({
    type: "text",
    mimeType: "text/plain",
    text: textAttachment,
  });
  const { JsonlLocalAgentStore } = require("@cursor/sdk");
  const store = new JsonlLocalAgentStore(join(paseoHome, "cursor-sdk"));
  const connect = () =>
    new DaemonClient({
      url: `ws://${listener()}/ws`,
      appVersion: "0.32.1",
      clientId: "cursor-parity-controls",
      reconnect: { enabled: false },
    });
  let client = connect();
  const inspect = (requested) =>
    cli("provider", "inspect", "cursor-sdk", "--cwd", workspace, "--model", requested);
  const status = async (id) => (await client.fetchAgent(id)).agent;
  const run = (...flags) =>
    cli(
      "run",
      "--workspace",
      workspaceId,
      "--relationship",
      "detached",
      "--no-notify-on-finish",
      "--wait-timeout",
      "12s",
      "--prompt",
      "Run P7 shell canary.",
      ...flags,
    );
  const native = async (agent) => {
    const nativeId = agent.persistence.nativeHandle;
    const { items } = await store.runs.list({ filter: { agentIds: [nativeId] } });
    return items.toSorted((a, b) => b.turnNumber - a.turnNumber)[0];
  };
  const send = async (id, text, options = {}) => {
    const messageId = randomUUID();
    const response = await client.sendAgentMessage(id, text, { messageId, ...options });
    assert.equal(response.disposition, "turn_started");
    assert.equal((await client.waitForFinish(id, 12_000)).status, "idle");
    return messageId;
  };
  const effective = async (id, expectedId, expectedFast, expectedReasoning, checkRun = true) => {
    const agent = await status(id);
    assert.equal(agent.model, expectedId);
    assert.equal(agent.effectiveThinkingOptionId, expectedReasoning);
    if (expectedFast == null) assert.equal(Object.hasOwn(agent.options ?? {}, fast), false);
    else assert.equal(agent.options[fast], expectedFast);
    if (expectedReasoning == null)
      assert.equal(Object.hasOwn(agent.options ?? {}, reasoning), false);
    else assert.equal(agent.options[reasoning], expectedReasoning);
    if (checkRun) {
      const actual = await native(agent);
      assert.equal(actual.model.id, expectedId);
      const params =
        expectedFast == null
          ? []
          : [
              { id: "fast", value: expectedFast },
              { id: "reasoning_effort", value: expectedReasoning },
            ];
      assert.deepEqual(sorted(actual.model.params), params);
    }
    return agent;
  };

  try {
    await client.connect();
    assert.equal((await inspect("auto")).selectedModel, "default");
    assert.equal((await inspect("auto-smart")).selectedModel, "auto-smart");
    const staleDraft = await client.createAgent({
      workspaceId,
      config: {
        provider: "cursor-sdk",
        cwd: workspace,
        model: "auto",
        providerOptions: { [fast]: true },
      },
    });
    await send(staleDraft.id, "Run after selecting Auto in the draft.");
    await effective(staleDraft.id, "default", null, null);
    const unavailableDefault = await run(
      "--provider",
      "cursor-sdk",
      "--model",
      "fixture-high-only",
    );
    assert.equal(unavailableDefault.status, "completed");
    await effective(unavailableDefault.agentId, "fixture-high-only", null, null);
    await assert.rejects(
      run("--provider", "cursor-sdk", "--model", model, "--feature", "cursor_model_fats=false"),
      (error) =>
        /Unsupported Cursor SDK model option/.test(
          String(error.stdout ?? "") + String(error.stderr ?? ""),
        ),
    );
    const explicit = await run(
      "--provider",
      "cursor-sdk",
      "--model",
      "fixture-alias",
      "--feature",
      `${fast}=false`,
    );
    assert.equal(explicit.status, "completed");
    await effective(explicit.agentId, model, "false", "high");

    await cli(
      "profile",
      "add",
      JSON.stringify({
        id: "p7-controls",
        name: "P7 controls",
        provider: "cursor-sdk",
        model,
        thinkingOptionId: "none",
        featureValues: { [reasoning]: "none" },
      }),
    );
    const profile = await run("--profile", "p7-controls", "--thinking", "high");
    assert.equal(profile.status, "completed");
    await effective(profile.agentId, model, "false", "high");
    await assert.rejects(
      run(
        "--provider",
        "cursor-sdk",
        "--model",
        model,
        "--features-json",
        JSON.stringify({ [fast]: "invalid" }),
      ),
    );
    await cli(
      "agent",
      "update",
      explicit.agentId,
      "--features-json",
      JSON.stringify({ [fast]: "true" }),
    );
    await send(explicit.agentId, "Run the updated canary.");
    await effective(explicit.agentId, model, "true", "none");
    await assert.rejects(
      cli(
        "agent",
        "update",
        explicit.agentId,
        "--features-json",
        JSON.stringify({ [fast]: false, [reasoning]: "none" }),
      ),
      (error) =>
        /Unsupported Cursor SDK model option combination/.test(
          String(error.stdout ?? "") + String(error.stderr ?? ""),
        ),
    );
    await effective(explicit.agentId, model, "true", "none");
    await assert.rejects(
      cli("agent", "update", explicit.agentId, "--thinking", "none", "--feature", `${fast}=false`),
      (error) =>
        /Unsupported Cursor SDK model option combination/.test(
          String(error.stdout ?? "") + String(error.stderr ?? ""),
        ),
    );
    await effective(explicit.agentId, model, "true", "none", false);
    await cli(
      "agent",
      "update",
      explicit.agentId,
      "--profile",
      "p7-controls",
      "--thinking",
      "high",
    );
    await send(explicit.agentId, "Run after the live profile update.");
    await effective(explicit.agentId, model, "false", "high");
    await cli("agent", "update", explicit.agentId, "--model", "fixture-high");
    await send(explicit.agentId, "Run after model switch.");
    await effective(explicit.agentId, "fixture-high", "false", "high");
    await cli("agent", "update", explicit.agentId, "--model", "auto-smart");
    await send(explicit.agentId, "Run on Smart Auto.");
    await effective(explicit.agentId, "auto-smart", null, null);
    await cli("agent", "update", explicit.agentId, "--model", "default");
    await send(explicit.agentId, "Run on default Auto.");
    await effective(explicit.agentId, "default", null, null);
    console.log(
      "PASS CLI flags, JSON and profile resolved to snapshot and native options; rejects and model defaults stayed consistent.",
    );

    const attachmentAgent = await client.createAgent({
      workspaceId,
      config: { provider: "cursor-sdk", cwd: workspace, model, systemPrompt: providerInstruction },
    });
    const { file, error: uploadError } = await client.uploadFile({
      fileName: "p7-file.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(fileText),
    });
    assert.ok(file, uploadError);
    const wireStart = backend.wireCount;
    const imageOnlyId = await send(attachmentAgent.id, "", { images: [image] });
    const imageOnlyWireEnd = backend.wireCount;
    const mixedId = await send(attachmentAgent.id, userText, {
      images: [image],
      attachments: [inlineAttachment, AgentAttachmentSchema.parse(file)],
    });
    const imageBytes = Buffer.from(image.data, "base64");
    for (const slices of [
      backend.wire(wireStart, imageOnlyWireEnd),
      backend.wire(imageOnlyWireEnd),
    ]) {
      assert.ok(
        slices.some((bytes) => bytes.includes(imageBytes)),
        "Missing native image bytes",
      );
      assert.ok(
        slices.some((bytes) => bytes.includes(image.mimeType)),
        "Missing native image MIME",
      );
    }
    const mixedWire = backend.wire(imageOnlyWireEnd);
    assert.ok(mixedWire.some((bytes) => bytes.includes(providerInstruction)));
    assert.ok(mixedWire.some((bytes) => bytes.includes(userText)));
    assert.ok(mixedWire.some((bytes) => bytes.includes(textAttachment)));
    assert.ok(mixedWire.some((bytes) => bytes.includes(file.fileName)));

    const clientPromptRows = async () =>
      (await client.fetchAgentTimeline(attachmentAgent.id, { limit: 100 })).entries
        .filter(({ item }) => item.type === "user_message")
        .map(({ item, turnId }) => ({ item, turnId }));
    const original = await clientPromptRows();
    assert.deepEqual(
      original.map(({ item }) => item.clientMessageId),
      [imageOnlyId, mixedId],
    );
    assert.equal(original[1].item.text, userText);

    await client.close();
    await restart();
    client = connect();
    await client.connect();
    assert.deepEqual(await clientPromptRows(), original);
    const saved = await status(attachmentAgent.id);
    const journal = join(
      paseoHome,
      "cursor-sdk",
      "paseo-turns",
      hash(saved.persistence.nativeHandle),
    );
    for (const { item, turnId } of original) {
      const inputPath = join(journal, `${hash(turnId)}-${hash(item.messageId)}.input.json`);
      const input = JSON.parse(await readFile(inputPath, "utf8"));
      assert.ok(
        input.some(
          (part) =>
            part.type === "image" &&
            part.mimeType === image.mimeType &&
            hash(Buffer.from(part.data, "base64")) === hash(imageBytes),
        ),
      );
      if (item.clientMessageId === mixedId) assert.ok(input.some((part) => part.id === file.id));
    }
    await effective(profile.agentId, model, "false", "high", false);
    await effective(unavailableDefault.agentId, "fixture-high-only", null, null, false);
    await effective(explicit.agentId, "default", null, null, false);
    await client.fetchAgentTimeline(explicit.agentId, { limit: 10 });
    await effective(explicit.agentId, "default", null, null, false);
    await send(profile.agentId, "Run after cold reopen.");
    await effective(profile.agentId, model, "false", "high");
    console.log(
      "PASS native image and mixed references, prompt IDs and journal inputs after daemon restart.",
    );
  } finally {
    await client.close();
  }
}
