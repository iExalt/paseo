import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "@bufbuild/protobuf";

const untrustedId = "wks_cursor_parity_untrusted";
const questionServer = "custom-user-tools";
const questionTool = "ask_question";
const explicitServer = "paseo_explicit";
const token = "PASEO_P5_ONLY_FROM_ANSWER";
const workspaceMarker = "PASEO_P5_TRUSTED_AGENTS";
const cursorMarker = "PASEO_P5_TRUSTED_CURSOR_RULE";
const excluded = ["PASEO_P5_CONTEXTUAL_RULE", "PASEO_P5_UNTRUSTED_AGENTS", "PASEO_P5_USER_RULE"];
const questions = [{ question: "Where should I put the result?", options: ["Report", "Chat"] }];

const stdioFixture = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], "started");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: {tools:{}},
        serverInfo: {name:"p5", version:"1"} }
    : request.method === "tools/list"
      ? { tools: [{name:"p5_echo", description:"Fixture explicit tool", inputSchema:{type:"object"}}] }
      : { content: [{type:"text", text:"PASEO_P5_EXPLICIT_TOOL"}] };
  console.log(JSON.stringify({jsonrpc:"2.0", id:request.id, result}));
}
`;

const missing = async (path) => {
  await assert.rejects(readFile(path), { code: "ENOENT" });
};

export async function prepareP5Fixture({ root, paseoHome, home, workspace }) {
  const { createPersistedWorkspaceRecord } = await import(
    pathToFileURL(join(root, "packages/server/dist/server/server/workspace-registry.js"))
  );
  const untrusted = join(workspace, "untrusted");
  const files = join(paseoHome, "projects", "workspaces.json");
  const workspaces = JSON.parse(await readFile(files, "utf8"));
  const stamp = new Date().toISOString();
  workspaces.push(
    createPersistedWorkspaceRecord({
      workspaceId: untrustedId,
      projectId: workspaces[0].projectId,
      cwd: untrusted,
      kind: "directory",
      displayName: "Untrusted parity fixture",
      createdAt: stamp,
      updatedAt: stamp,
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 1,
        headRepository: "paseo-fixture/fork",
      },
    }),
  );
  const script = join(workspace, "p5-mcp.mjs");
  const mcp = (name) => ({
    type: "stdio",
    command: process.execPath,
    args: [script, join(workspace, `${name}.started`)],
  });
  function hooks(marker) {
    return JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: `touch "${join(workspace, marker)}"` }] },
    });
  }
  await Promise.all([
    mkdir(join(workspace, ".cursor", "rules"), { recursive: true }),
    mkdir(join(untrusted, ".cursor"), { recursive: true }),
    mkdir(join(home, ".cursor", "rules"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(files, JSON.stringify(workspaces)),
    writeFile(join(workspace, "AGENTS.md"), workspaceMarker),
    writeFile(
      join(workspace, ".cursor", "rules", "always.mdc"),
      `---\nalwaysApply: true\n---\n${cursorMarker}\n`,
    ),
    writeFile(
      join(workspace, ".cursor", "rules", "contextual.mdc"),
      `---\nglobs: "*.ts"\n---\n${excluded[0]}\n`,
    ),
    writeFile(join(untrusted, "AGENTS.md"), excluded[1]),
    writeFile(
      join(home, ".cursor", "rules", "always.mdc"),
      `---\nalwaysApply: true\n---\n${excluded[2]}\n`,
    ),
    writeFile(join(untrusted, ".cursor", "hooks.json"), hooks("p5-workspace-hook.started")),
    writeFile(join(home, ".cursor", "hooks.json"), hooks("p5-user-hook.started")),
    writeFile(
      join(untrusted, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { p5_ambient_project: mcp("p5-project-mcp") } }),
    ),
    writeFile(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { p5_ambient_user: mcp("p5-user-mcp") } }),
    ),
    writeFile(script, stdioFixture),
    writeFile(join(workspace, "p5-protected.sh"), "printf permitted >> p5-protected.txt\n"),
  ]);
  return { untrusted, explicitMcp: mcp("p5-explicit-mcp") };
}

export function selectP5Turn(raw, { bytes, frame, number, fields, concat }) {
  const mode = /PASEO_P5_TEST_(ALLOW|DENY|STOP|UNTRUSTED|NEXT)/.exec(raw.toString())?.[1];
  if (!mode) return;
  const untrusted = mode === "UNTRUSTED";
  for (const marker of [workspaceMarker, cursorMarker])
    assert.equal(raw.includes(marker), !untrusted, marker);
  for (const marker of excluded) assert.ok(!raw.includes(marker), marker);
  const server = untrusted ? explicitServer : questionServer;
  const tool = untrusted ? "p5_echo" : questionTool;
  const execId = `p5-${mode.toLowerCase()}`;
  const request = (id, field, payload) =>
    frame(bytes(2, concat(number(1, id), bytes(15, execId), bytes(field, payload))));

  return {
    start(stream) {
      stream.write(request(51, 36, untrusted ? Buffer.alloc(0) : bytes(1, server)));
    },
    reply(reply, stream) {
      if (reply[36]) {
        assert.equal(reply[1], 51, "MCP discovery reply ID did not match the request");
        assert.ok(fields(reply[36])[1], "MCP discovery failed");
        assert.ok(reply[36].includes(tool), "MCP discovery omitted the requested tool");
        assert.ok(!reply[36].includes("p5_ambient_"), "Ambient MCP was registered");
        const args = untrusted ? {} : { questions };
        stream.write(
          request(
            52,
            11,
            concat(
              bytes(1, tool),
              ...Object.entries(args).map(([key, value]) =>
                bytes(2, concat(bytes(1, key), bytes(2, Value.fromJson(value).toBinary()))),
              ),
              bytes(3, execId),
              bytes(4, server),
              bytes(5, tool),
              bytes(9, server),
            ),
          ),
        );
        return "continue";
      }
      assert.ok(reply[11], "Expected a real SDK MCP executor response");
      assert.equal(reply[1], 52, "MCP tool reply ID did not match the request");
      if (reply[11].includes(token) && mode !== "NEXT") return "protected";
      if (mode === "STOP") return "continue";
      if (mode === "DENY") {
        assert.ok(reply[11].includes("dismissed"), "SDK did not receive the denial");
        return "finish";
      }
      if (untrusted) {
        assert.ok(reply[11].includes("PASEO_P5_EXPLICIT_TOOL"), "Explicit MCP call failed");
        return "finish";
      }
      assert.ok(reply[11].includes(token), "SDK did not receive the submitted answer");
      return "finish";
    },
  };
}

export async function checkP5Interactions({
  require,
  listener,
  paseoHome,
  workspace,
  workspaceId,
  fixtures,
  model,
  expectOwner,
}) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://${listener()}/ws`,
      appVersion: "0.32.1",
      clientId: "cursor-parity-p5",
      reconnect: { enabled: false },
    });
    await client.connect();
    return client;
  };
  let client = await connect();
  const config = {
    cwd: workspace,
    workspaceId,
    provider: "cursor-sdk",
    modeId: "unrestricted",
    model,
  };
  const answer = { behavior: "allow", updatedInput: { answers: { "Question 1": token } } };
  const protectedFile = join(workspace, "p5-protected.txt");
  const pending = async (id) => {
    const state = await client.waitForAgentUpsert(
      id,
      (snapshot) => snapshot.pendingPermissions.length === 1,
      5000,
    );
    const [question] = state.pendingPermissions;
    assert.equal(question.kind, "question");
    assert.deepEqual(question.input.questions, [
      {
        ...questions[0],
        options: [{ label: "Report" }, { label: "Chat" }],
        header: "Question 1",
        multiSelect: false,
        allowOther: true,
      },
    ]);
    return question.id;
  };
  async function start(mode) {
    const agent = await client.createAgent({ ...config, initialPrompt: `PASEO_P5_TEST_${mode}` });
    return { id: agent.id, request: await pending(agent.id) };
  }
  const settled = async (id) => {
    const state = await client.waitForAgentUpsert(
      id,
      (snapshot) => snapshot.status !== "running" && snapshot.pendingPermissions.length === 0,
      5000,
    );
    assert.equal(state.status, "idle", state.lastError);
  };
  try {
    await assert.rejects(client.createAgent({ ...config, modeId: "plan" }), /mode|Unrestricted/i);
    for (const [server, tool] of [
      ["hub", "finish_execution"],
      ["hub-lookalike", "finish_execution"],
      ["hub", "finish_execution_lookalike"],
    ]) {
      await assert.rejects(
        client.createAgent({
          ...config,
          mcpServers: { [server]: fixtures.explicitMcp },
          toolPolicy: { preapproved: [{ kind: "mcp", server, tool }] },
        }),
        /cannot preapprove exact MCP tools/i,
      );
    }

    const denied = await start("DENY");
    await client.respondToPermissionAndWait(denied.id, denied.request, { behavior: "deny" }, 5000);
    await settled(denied.id);
    await missing(protectedFile);

    const stopped = await start("STOP");
    assert.equal(await client.cancelAgent(stopped.id), true);
    await settled(stopped.id);
    await missing(protectedFile);
    await client.sendAgentMessage(stopped.id, "PASEO_P5_TEST_NEXT");
    const next = await pending(stopped.id);
    assert.notEqual(next, stopped.request);
    await assert.rejects(
      client.respondToPermissionAndWait(stopped.id, stopped.request, answer, 2000),
      /question is no longer pending/i,
    );
    assert.equal(await pending(stopped.id), next);
    await client.respondToPermissionAndWait(stopped.id, next, answer, 5000);
    await settled(stopped.id);

    const allowed = await start("ALLOW");
    if (expectOwner) {
      const { agent } = await client.fetchAgent(allowed.id);
      const nativeId = agent.persistence.nativeHandle;
      const digest = createHash("sha256").update(nativeId).digest("hex");
      const dir = join(paseoHome, "cursor-sdk", "paseo-turns", digest);
      const journals = (await readdir(dir)).filter((name) => name.endsWith(".turn.json"));
      assert.equal(journals.length, 1);
      const saved = JSON.parse(await readFile(join(dir, journals[0]), "utf8"));
      assert.ok(saved.executionOwner, "Question proof did not use the production owner path");
      assert.ok(saved.executionRunIds.includes(saved.nativeRunId));
    }
    await missing(protectedFile);
    await client.close();
    client = await connect();
    assert.equal(await pending(allowed.id), allowed.request);
    await assert.rejects(
      client.respondToPermissionAndWait(
        allowed.id,
        allowed.request,
        { behavior: "allow", updatedInput: { answers: { "Question 1": 123 } } },
        2000,
      ),
      /valid answer for every Cursor SDK question/i,
    );
    assert.equal(await pending(allowed.id), allowed.request);
    await missing(protectedFile);
    await client.respondToPermissionAndWait(allowed.id, allowed.request, answer, 5000);
    await settled(allowed.id);
    assert.equal(await readFile(protectedFile, "utf8"), "permitted");
    console.log(
      "PASS Cursor SDK discover/call, question reconnect, invalid and late replies, deny, Stop and allow",
    );

    const untrusted = await client.createAgent({
      ...config,
      cwd: fixtures.untrusted,
      workspaceId: untrustedId,
      initialPrompt: "PASEO_P5_TEST_UNTRUSTED",
      mcpServers: { [explicitServer]: fixtures.explicitMcp },
    });
    await settled(untrusted.id);
    assert.equal(await readFile(join(workspace, "p5-explicit-mcp.started"), "utf8"), "started");
    for (const marker of ["p5-workspace-hook", "p5-user-hook", "p5-project-mcp", "p5-user-mcp"])
      await missing(join(workspace, `${marker}.started`));
    console.log(
      "PASS Cursor workspace trust, blocked ambient hooks and file MCP, explicit MCP, and fail-closed grants",
    );
  } finally {
    await client.close();
  }
}
