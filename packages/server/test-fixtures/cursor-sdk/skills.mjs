import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { model } from "./backend.mjs";

const skillName = "cursor-parity-selected-skill";
const skillMarker = "PASEO_SKILL_FROM_SELECTED_WORKSPACE";
const userMarker =
  "<paseo_selected_cursor_skills>\nKeep the exact user text for this fixture.\n</paseo_selected_cursor_skills>";
const textAttachment = "PASEO_SELECTED_SKILL_TEXT_ATTACHMENT";
const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBk0AAAAASUVORK5CYII=",
};

export async function installSkillFixtures(workspace, home) {
  const workspaceRoot = join(workspace, "cursor-selected-skills");
  const workspaceAlias = join(workspace, ".cursor", "skills");
  const userRoot = join(home, ".agents", "skills");
  const disallowedRoot = join(home, ".codex", "skills");
  const file = join(workspaceRoot, skillName, "SKILL.md");
  const write = (root, name, description, body) =>
    writeFile(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    );
  await mkdir(join(workspace, ".cursor"), { recursive: true });
  await mkdir(join(workspaceRoot, skillName), { recursive: true });
  await mkdir(join(userRoot, skillName), { recursive: true });
  await mkdir(join(disallowedRoot, "cursor-parity-outside"), { recursive: true });
  await symlink(workspaceRoot, workspaceAlias, "dir");
  await write(workspaceRoot, skillName, "Selected workspace skill", skillMarker);
  await write(userRoot, skillName, "Shadowed user skill", "PASEO_SKILL_FROM_WRONG_SOURCE");
  await write(
    disallowedRoot,
    "cursor-parity-outside",
    "Out of scope provider home",
    "PASEO_SKILL_FROM_UNAPPROVED_SOURCE",
  );
  await writeFile(
    join(workspace, "cursor-selected-canary.sh"),
    `printf '%s' '${skillMarker}' > cursor-selected-canary.txt\nprintf '%s' '${skillMarker}'\n`,
  );
  return {
    file,
    update: () => write(workspaceRoot, skillName, "Edited workspace skill", skillMarker),
  };
}

export function assertSkillTurnRequest(raw) {
  if (!raw.includes("Keep the exact user text for this fixture.")) return false;
  assert.ok(
    raw.includes(skillMarker),
    "Cursor inference did not receive the selected skill content",
  );
  assert.ok(raw.includes(textAttachment), "Cursor inference lost the text attachment");
  assert.ok(
    raw.includes(Buffer.from(image.data, "base64")) || raw.includes(image.data),
    "Cursor inference lost the image attachment",
  );
  assert.ok(
    !raw.includes("PASEO_SKILL_FROM_WRONG_SOURCE"),
    "Cursor invoked the shadowed user skill",
  );
  return true;
}

async function connectFixture(require, listener, clientId, capabilities) {
  const { DaemonClient } = await import(
    pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client"))
  );
  const client = new DaemonClient({
    url: "ws://" + listener() + "/ws",
    appVersion: "0.32.1",
    clientId,
    reconnect: { enabled: false },
    capabilities,
  });
  await client.connect();
  await client.fetchAgents();
  return client;
}

export async function checkDraftSkills({ cli, workspace, paseoHome, backend, require, listener }) {
  const attempts = backend.runs;
  const draft = (...args) => cli("provider", "commands", "cursor-sdk", "--cwd", workspace, ...args);
  const nativeStore = async () =>
    readdir(join(paseoHome, "cursor-sdk")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
  const beforeStore = await nativeStore();
  const withModel = await draft("--model", model);
  const withoutModel = await draft();
  assert.deepEqual(withModel, withoutModel);
  assert.equal(backend.runs, attempts);
  assert.deepEqual(await nativeStore(), beforeStore, "Catalog created an SDK agent store entry");
  assert.deepEqual(
    withoutModel.map(({ name, skill }) => [name, skill.scope]),
    [[skillName, "workspace"]],
  );
  console.log("PASS Cursor draft catalogs agree with and without a model, without an SDK turn");
  const draftConfig = { provider: "cursor-sdk", cwd: workspace, skillScope: "user" };
  const modern = await connectFixture(require, listener, "cursor-skills-user-scope");
  try {
    const catalog = await modern.listCommands({ agentId: "__new_agent__", draftConfig });
    assert.equal(catalog.error, null);
    assert.deepEqual(
      catalog.commands.map(({ name, skill }) => [name, skill.scope]),
      [[skillName, "user"]],
    );
  } finally {
    await modern.close();
  }

  const old = await connectFixture(require, listener, "cursor-skills-old-app", {
    cursor_sdk_skill_selection: false,
  });
  try {
    const catalog = await old.listCommands({ agentId: "__new_agent__", draftConfig });
    assert.equal(catalog.error, null);
    assert.deepEqual(catalog.commands, []);
  } finally {
    await old.close();
  }
  assert.equal(backend.runs, attempts);
  assert.deepEqual(await nativeStore(), beforeStore);
  return withoutModel[0].skill;
}

async function checkQueuedSkill({ client, backend, workspace, workspaceId, fixture, reference }) {
  const script = join(workspace, "cursor-canary.sh");
  const original = await readFile(script);
  const hold = join(workspace, "cursor-queued-skill-hold");
  await writeFile(hold, "");
  await writeFile(script, "while [ -f cursor-queued-skill-hold ]; do sleep 0.025; done\n");
  const before = backend.runs;
  try {
    const agent = await client.createAgent({
      workspaceId,
      provider: "cursor-sdk",
      cwd: workspace,
      model,
      modeId: "unrestricted",
      initialPrompt: "Hold the fixture before dispatching the queued skill.",
    });
    const queued = await client.sendAgentMessage(agent.id, "Preserve this queued text.", {
      messageId: "cursor-queued-skill",
      attachments: [{ type: "cursor_skill", reference }],
      activeTurnBehavior: "queue",
    });
    assert.equal(queued.disposition, "queued");
    await rm(fixture);
    await rm(hold);
    const deadline = AbortSignal.timeout(5000);
    while (!deadline.aborted) {
      const { agent: snapshot } = await client.fetchAgent(agent.id);
      if (snapshot.lastError?.includes("select it again from the skill menu")) {
        assert.equal(backend.runs, before + 1, "The invalid queued selection dispatched");
        console.log("PASS queued skill is revalidated after removal before native dispatch");
        return;
      }
      await delay(40);
    }
    throw new Error("Queued selection did not surface the reselection error");
  } finally {
    await rm(hold, { force: true });
    await writeFile(script, original);
  }
}

export async function checkSelectedSkills({
  backend,
  startDaemon,
  stopDaemon,
  listener,
  require,
  cli,
  workspace,
  workspaceId,
  fixtures,
  selection,
}) {
  const connect = () => connectFixture(require, listener, "cursor-parity-skills");
  const selectedAttachment = { type: "cursor_skill", reference: selection };
  let client = await connect();
  try {
    const launchesBefore = backend.runs;
    const agent = await client.createAgent({
      workspaceId,
      provider: "cursor-sdk",
      cwd: workspace,
      model,
      modeId: "unrestricted",
      initialPrompt: userMarker,
      clientMessageId: "cursor-parity-selected-skill",
      images: [image],
      attachments: [
        selectedAttachment,
        { type: "text", mimeType: "text/plain", text: textAttachment },
      ],
    });
    const finished = await client.waitForFinish(agent.id, 12_000);
    assert.equal(finished.status, "idle");
    assert.equal(backend.runs, launchesBefore + 1);
    assert.equal(
      await readFile(join(workspace, "cursor-selected-canary.txt"), "utf8"),
      skillMarker,
    );
    const latestCatalog = async () =>
      (await client.listCommands({ agentId: agent.id })).commands.find(
        (row) => row.name === skillName,
      );
    assert.deepEqual((await latestCatalog()).skill, selection);

    await client.close();
    await stopDaemon();
    await startDaemon();
    client = await connect();
    assert.deepEqual((await latestCatalog()).skill, selection);
    const { entries } = await cli("logs", agent.id);
    const messages = entries.map(({ item }) => item).filter(({ type }) => type === "user_message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, userMarker);
    assert.deepEqual(messages[0].cursorSkills, [selection]);
    assert.equal(backend.runs, launchesBefore + 1, "Cold replay launched another SDK turn");
    for (const { item } of entries) {
      if (item.type === "user_message") assert.ok(!item.text.includes(skillMarker));
    }

    const catalogEvents = client.observeEvents(["agent.commands.changed"]);
    await catalogEvents.ready;
    const commandUpdate = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Cursor skill catalog did not publish an edit"));
      }, 5000);
      const unsubscribe = client.subscribeRawMessages((message) => {
        if (
          message.type !== "agent.commands.changed" ||
          message.payload.agentId !== agent.id ||
          message.payload.subscriptionId !== catalogEvents.subscriptionId
        )
          return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
    await fixtures.update();
    await commandUpdate;
    const edited = (await latestCatalog()).skill;
    assert.equal(edited.id, selection.id);
    assert.notEqual(edited.revision, selection.revision);
    await assert.rejects(
      client.sendAgentMessage(agent.id, "Keep this as a draft after rejection", {
        attachments: [selectedAttachment],
        activeTurnBehavior: "interrupt",
      }),
      /select it again from the skill menu/i,
    );
    assert.equal(backend.runs, launchesBefore + 1);
    console.log(
      "PASS selected skill canary, text/image dispatch, cold references, and stale rejection",
    );
    await checkQueuedSkill({
      client,
      backend,
      workspace,
      workspaceId,
      fixture: fixtures.file,
      reference: edited,
    });
  } finally {
    await client.close();
  }
}
