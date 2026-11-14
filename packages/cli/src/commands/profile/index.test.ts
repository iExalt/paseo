import { runSkillsCommand, createSkillsCommand } from "../skills/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { runProfileLsCommand } from "./index.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createClient() {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "profile-list-test",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-test",
      features: {},
    }),
  );
  const listProfiles = vi.spyOn(client, "listAgentProfiles").mockResolvedValue({
    requestId: "profile-list",
    profiles: [],
  });
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, listProfiles };
}

describe("runProfileLsCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an old daemon before sending profile.list", async () => {
    const { client, listProfiles } = createClient();

    await expect(runProfileLsCommand({ daemonTarget }, new Command())).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });

    expect(listProfiles).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
});

it("skills mutations reject obsolete confirmation flags", async () => {
  for (const flag of ["--force", "--yes"]) {
    const command = createSkillsCommand().exitOverride();
    const uninstall = command.commands.find((entry) => entry.name() === "uninstall")!;
    uninstall.exitOverride().configureOutput({ writeErr: () => {} });
    uninstall.action(() => {});
    await expect(command.parseAsync(["uninstall", flag], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  }
});

it("skills selection confirms exactly the removals returned by the host", async () => {
  const status = {
    state: "up-to-date" as const,
    ops: [],
    available: ["a"],
    installed: ["a"],
    selection: { mode: "all" as const },
  };
  const confirmations: (readonly string[] | undefined)[] = [];
  let closed = false;
  const result = await runSkillsCommand(
    "select",
    [],
    { daemonTarget, all: true },
    new Command(),
    async () => ({
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "host",
        features: { skillManagement: true },
      }),
      getAgentSkillsStatus: async () => status,
      reconcileAgentSkills: async () => status,
      uninstallAgentSkills: async () => status,
      saveAgentSkillsSelection: async (selection, removals) => {
        expect(selection).toEqual({ mode: "all" });
        confirmations.push(removals);
        return {
          ...status,
          confirmationRequired: removals === undefined ? { removals: ["obsolete"] } : null,
        };
      },
      close: async () => {
        closed = true;
      },
    }),
  );
  expect(confirmations).toEqual([undefined, ["obsolete"]]);
  expect(result.data).toMatchObject({ state: "up-to-date", confirmationRequired: null });
  expect(closed).toBe(true);
});

it("skills selection fails when removal confirmation changes", async () => {
  const status = {
    state: "drift" as const,
    ops: [],
    available: [],
    installed: [],
    selection: { mode: "all" as const },
  };
  let calls = 0;
  await expect(
    runSkillsCommand("select", [], { daemonTarget, none: true }, new Command(), async () => ({
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "host",
        features: { skillManagement: true },
      }),
      getAgentSkillsStatus: async () => status,
      reconcileAgentSkills: async () => status,
      uninstallAgentSkills: async () => status,
      saveAgentSkillsSelection: async () => {
        calls++;
        return { ...status, confirmationRequired: { removals: [String(calls)] } };
      },
      close: async () => {},
    })),
  ).rejects.toMatchObject({ code: "CONFIRMATION_CHANGED" });
  expect(calls).toBe(2);
});

function skillsFixture(supported: boolean) {
  const calls: string[] = [];
  const status = {
    state: "up-to-date" as const,
    ops: [],
    available: ["agent-tools"],
    installed: [],
    selection: { mode: "all" as const },
  };
  const connect = async () => ({
    getLastServerInfoMessage: () => ({
      status: "server_info" as const,
      serverId: "host",
      features: { skillManagement: supported },
    }),
    getAgentSkillsStatus: async () => {
      calls.push("status");
      return status;
    },
    reconcileAgentSkills: async () => {
      calls.push("reconcile");
      return status;
    },
    uninstallAgentSkills: async () => {
      calls.push("uninstall");
      return status;
    },
    saveAgentSkillsSelection: async () => {
      calls.push("save");
      return { ...status, confirmationRequired: null };
    },
    close: async () => {
      calls.push("close");
    },
  });
  return { calls, connect };
}

it.each(["status", "reconcile", "uninstall"] as const)(
  "skills %s dispatches only that operation",
  async (action) => {
    const fake = skillsFixture(true);
    await runSkillsCommand(action, [], { daemonTarget }, new Command(), fake.connect);
    expect(fake.calls).toEqual([action, "close"]);
  },
);

it("skills gates unsupported hosts before skill RPCs", async () => {
  const fake = skillsFixture(false);
  await expect(
    runSkillsCommand("status", [], { daemonTarget }, new Command(), fake.connect),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
  expect(fake.calls).toEqual(["close"]);
});

it("skills rejects unknown names before any mutation", async () => {
  const fake = skillsFixture(true);
  await expect(
    runSkillsCommand("select", ["agnt-tools"], { daemonTarget }, new Command(), fake.connect),
  ).rejects.toMatchObject({
    code: "INVALID_SELECTION",
    details: { unknown: ["agnt-tools"], available: ["agent-tools"] },
  });
  expect(fake.calls).toEqual(["status", "close"]);
});

it("skills checks and saves trimmed explicit names", async () => {
  const fake = skillsFixture(true);
  await runSkillsCommand(
    "select",
    [" agent-tools "],
    { daemonTarget },
    new Command(),
    async () => ({
      ...(await fake.connect()),
      saveAgentSkillsSelection: async (selection) => {
        expect(selection).toEqual({ mode: "custom", skills: ["agent-tools"] });
        return {
          state: "up-to-date",
          ops: [],
          available: ["agent-tools"],
          installed: ["agent-tools"],
          selection,
          confirmationRequired: null,
        };
      },
    }),
  );
  expect(fake.calls).toEqual(["status", "close"]);
});

it("skills rejects ambiguous or empty selections before connection", async () => {
  for (const selection of [{ all: true, none: true }, {}]) {
    await expect(
      runSkillsCommand("select", [], { daemonTarget, ...selection }, new Command(), async () => {
        throw new Error("must not connect");
      }),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  }
});
