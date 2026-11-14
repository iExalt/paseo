import { setImmediate as waitForCommandContinuations } from "node:timers/promises";
import { Command } from "commander";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAllowCommand, type PermitClient } from "./allow.js";
import { withOutput } from "../../output/index.js";
import { createDenyCommand } from "./deny.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";
const requests: AgentPermissionRequest[] = [
  {
    id: "permission-write",
    provider: "codex",
    name: "CodexBash",
    kind: "tool",
  },
  { id: "permission-edit", provider: "codex", name: "CodexBash", kind: "tool" },
];

class PermissionClient implements PermitClient {
  readonly pending: AgentPermissionRequest[];
  readonly responses = new Map<string, AgentPermissionResponse>();
  closed = false;
  private notifyReceived = () => {};
  private readonly confirmations = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(initial = requests) {
    this.pending = [...initial];
  }
  async fetchAgent() {
    return { agent: { id: agentId, pendingPermissions: this.pending } };
  }

  async respondToPermission(
    _agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) {
    this.responses.set(requestId, response);
    this.notifyReceived();
  }

  async respondToPermissionAndWait(
    responseAgentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const confirmation = new Promise<void>((resolve, reject) => {
      this.confirmations.set(requestId, { resolve, reject });
    });
    await this.respondToPermission(responseAgentId, requestId, response);
    await confirmation;
  }

  async close() {
    this.closed = true;
  }

  async waitForResponses(count: number) {
    while (this.responses.size < count) {
      await new Promise<void>((resolve) => {
        this.notifyReceived = resolve;
      });
    }
  }

  confirm(requestId: string) {
    const confirmation = this.confirmations.get(requestId);
    if (!confirmation) throw new Error(`No confirmation waiter: ${requestId}`);
    this.pending.splice(
      this.pending.findIndex((request) => request.id === requestId),
      1,
    );
    confirmation.resolve();
  }

  fail(requestId: string, error: Error) {
    const confirmation = this.confirmations.get(requestId);
    if (!confirmation) throw new Error(`No confirmation waiter: ${requestId}`);
    confirmation.reject(error);
  }
}

const question: AgentPermissionRequest = {
  id: "permission-question",
  provider: "codex",
  name: "request_user_input_async",
  kind: "question",
  input: {
    questions: [
      { id: "0", header: "Question 1" },
      { id: "1", header: "Destination" },
    ],
  },
};

describe("permit allow question answers", () => {
  it.each([
    undefined,
    { answers: { "0": { answers: ["Green"] } } },
    { "0": "Green" },
    { answers: { "0": "Green" } },
    { answers: { "Question 1": "Green" } },
    { answers: { "Question 1": " ", Destination: "Here" } },
    { answers: { "Question 1": "Green", Destination: ["Here"] } },
    { answers: { "Question 1": "Green", Destination: "Here", Typo: "Oops" } },
  ])(
    "rejects malformed/incomplete answers before sending any selected response: %j",
    async (input) => {
      const client = new PermissionClient([...requests, question]);
      const result = await createAllowCommand(async () => client)(
        agentId,
        undefined,
        {
          ...options,
          all: true,
          ...(input === undefined ? {} : { input: JSON.stringify(input) }),
        },
        new Command(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.data).toHaveLength(3);
      expect(result.data.every((item) => item.status === "failed")).toBe(true);
      expect(result.data[2].error).toContain("Invalid answers");
      expect(client.responses.size).toBe(0);
      expect(client.pending).toEqual([...requests, question]);
      expect(client.closed).toBe(true);
    },
  );

  it("prints every not-sent outcome when batch preflight fails", async () => {
    const client = new PermissionClient([...requests, question]);
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const cmd = new Command().option("--json").option("--all");
    cmd.parse(["--json", "--all"], { from: "user" });
    await withOutput(createAllowCommand(async () => client))(agentId, undefined, options, cmd);
    expect(process.exitCode).toBe(1);
    const rows = JSON.parse(stdout);
    expect(rows.map((item: { requestId: string }) => item.requestId)).toEqual(
      [...requests, question].map((item) => item.id),
    );
    expect(rows.every((item: { status: string }) => item.status === "failed")).toBe(true);
    expect(rows[0].error).toContain("not sent");
    expect(rows[2].error).toContain("Invalid answers");
    expect(client.sentRequestIds).toEqual([]);
  });

  it("submits complete answers keyed by headers and waits for confirmation", async () => {
    const client = new PermissionClient([question]);
    const input = {
      answers: { "Question 1": "Green", Destination: "Free text, with punctuation" },
    };
    const command = createAllowCommand(async () => client)(
      agentId,
      question.id,
      {
        ...options,
        input: JSON.stringify(input),
      },
      new Command(),
    );
    await client.waitForResponses(1);
    expect(client.responses.get(question.id)).toEqual({ behavior: "allow", updatedInput: input });
    expect(client.pending).toEqual([question]);
    client.confirm(question.id);
    expect((await command).data[0].result).toBe("allowed");
    expect(client.pending).toEqual([]);
  });

  it("permits an empty answer only when the question explicitly allows it", async () => {
    const optionalQuestion = {
      ...question,
      input: { questions: [{ header: "Optional", allowEmpty: true }] },
    };
    const client = new PermissionClient([optionalQuestion]);
    const command = createAllowCommand(async () => client)(
      agentId,
      question.id,
      {
        ...options,
        input: JSON.stringify({ answers: { Optional: "" } }),
      },
      new Command(),
    );
    await client.waitForResponses(1);
    client.confirm(question.id);
    expect((await command).data[0].result).toBe("allowed");
  });
});

const options = {
  daemonTarget: { kind: "endpoint" as const, host: "test.invalid" },
};
const actions = [
  { name: "allow", create: createAllowCommand, result: "allowed" },
  { name: "deny", create: createDenyCommand, result: "denied" },
];
for (const action of actions) {
  describe(`permit ${action.name}`, () => {
    it("returns success and closes only after confirmation", async () => {
      const client = new PermissionClient();
      let completed = false;
      const command = action.create(async () => client)(
        agentId,
        requests[0].id,
        options,
        new Command(),
      );
      void command.then(
        () => (completed = true),
        () => false,
      );
      await client.waitForResponses(1);
      await waitForCommandContinuations();
      expect(completed).toBe(false);
      expect(client.closed).toBe(false);
      expect(client.pending).toEqual(requests);
      client.confirm(requests[0].id);
      const result = await command;
      expect(result.data).toEqual([
        {
          requestId: requests[0].id,
          agentId,
          agentShortId: agentId.slice(0, 7),
          name: "CodexBash",
          result: action.result,
          status: "confirmed",
        },
      ]);
      expect(client.closed).toBe(true);
      expect(client.pending).toEqual([requests[1]]);
    });

    it("waits for every confirmation with --all", async () => {
      const client = new PermissionClient();
      let completed = false;
      const command = action.create(async () => client)(
        agentId,
        undefined,
        { ...options, all: true },
        new Command(),
      );
      void command.then(
        () => (completed = true),
        () => false,
      );
      await client.waitForResponses(2);
      client.confirm(requests[0].id);
      // Wait beyond the first reply's promise continuations while withholding the second.
      await waitForCommandContinuations();
      expect(completed).toBe(false);
      expect(client.closed).toBe(false);
      client.confirm(requests[1].id);
      const result = await command;
      expect(result.data.map((item) => item.result)).toEqual([action.result, action.result]);
      expect(client.closed).toBe(true);
      expect(client.pending).toEqual([]);
    });

    it.each(["success-first", "failure-first"])(
      "retains complete mixed outcomes: %s",
      async (order) => {
        const client = new PermissionClient();
        const command = action.create(async () => client)(
          agentId,
          undefined,
          { ...options, all: true },
          new Command(),
        );
        await client.waitForResponses(2);
        if (order === "success-first") client.confirm(requests[0].id);
        else client.fail(requests[1].id, new Error("Acknowledgement lost"));
        await waitForCommandContinuations();
        expect(client.closed).toBe(false);
        if (order === "success-first")
          client.fail(requests[1].id, new Error("Acknowledgement lost"));
        else client.confirm(requests[0].id);
        const result = await command;
        expect(result.exitCode).toBe(1);
        expect(result.data.map((item) => [item.requestId, item.status, item.result])).toEqual([
          [requests[0].id, "confirmed", action.result],
          [requests[1].id, "unconfirmed", "unconfirmed"],
        ]);
        expect(result.data[1].error).toBe("Acknowledgement lost");
        expect(client.pending).toEqual([requests[1]]);
        expect(client.sentRequestIds).toEqual(requests.map((request) => request.id));
        expect(client.closed).toBe(true);
      },
    );

    it("returns a single unconfirmed result even if client cleanup fails", async () => {
      const client = new PermissionClient();
      client.close = async () => {
        throw new Error("Close failed");
      };
      const command = action.create(async () => client)(
        agentId,
        requests[0].id,
        options,
        new Command(),
      );
      await client.waitForResponses(1);
      client.fail(requests[0].id, new Error("Timeout waiting for message (15000ms)"));
      const result = await command;
      expect(result.exitCode).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        requestId: requests[0].id,
        status: "unconfirmed",
        result: "unconfirmed",
      });
    });

    it("reports all uncertain responses without retrying", async () => {
      for (const request of requests) client.fail(request.id, new Error("Transport disconnected"));
      const result = await command;
      expect(result.exitCode).toBe(1);
      expect(result.data.map((item) => item.status)).toEqual(["unconfirmed", "unconfirmed"]);
      expect(client.sentRequestIds).toHaveLength(2);
    it.each([true, false])(
      "renders complete mixed results and exits nonzero (json=%s)",
      async (json) => {
        const client = new PermissionClient();
        let stdout = "";
        const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          stdout += String(chunk);
          return true;
        });
        const cmd = new Command().option("--json").option("--all");
        cmd.parse([...(json ? ["--json"] : []), "--all"], { from: "user" });
        const command = withOutput(action.create(async () => client))(
          agentId,
          undefined,
          options,
          cmd,
        );
        await client.waitForResponses(2);
        client.fail(requests[1].id, new Error("Timeout waiting for confirmation"));
        await waitForCommandContinuations();
        expect(client.closed).toBe(false);
        client.confirm(requests[0].id);
        await command;
        expect(process.exitCode).toBe(1);
        if (json) {
          expect(JSON.parse(stdout).map((item: { status: string }) => item.status)).toEqual([
            "confirmed",
            "unconfirmed",
          ]);
          expect(JSON.parse(stdout)[0].result).toBe(action.result);
        } else {
          expect(stdout).toContain("confirmed");
          expect(stdout).toContain("unconfirmed");
          expect(stdout).toContain("Timeout waiting for confirmation");
        }
        write.mockRestore();
      },
    );
  });
}
