import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

export const sdkVersion = "1.4.2";
export const model = "paseo-loopback";
export const apiKey = "cursor-fixture-key";
export const assistantText = "PASEO_FIXTURE_DONE";
export const callId = "fixture-shell";

const token = "cursor-fixture-access-token";
const proto = "application/proto";
const connect = "application/connect+proto";
const join = (...parts) => Buffer.concat(parts);

function varint(value) {
  const encoded = [];
  while (value > 127) {
    encoded.push((value & 127) | 128);
    value >>>= 7;
  }
  return Buffer.from([...encoded, value]);
}

function bytes(field, value) {
  const payload = Buffer.from(value);
  return join(varint(field * 8 + 2), varint(payload.length), payload);
}

function number(field, value) {
  return join(varint(field * 8), varint(value));
}

function frame(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return join(header, payload);
}

const interaction = (field, value) => frame(bytes(1, bytes(field, value)));

function fields(body) {
  let offset = 0;
  const result = {};
  function readVarint() {
    for (let shift = 0, value = 0; offset < body.length && shift <= 28; shift += 7) {
      const next = body[offset++];
      value += (next & 127) * 2 ** shift;
      if (next < 128) return value;
    }
    throw new Error("Invalid fixture protobuf varint");
  }
  while (offset < body.length) {
    const tag = readVarint();
    assert.ok(tag >= 8, "Invalid fixture protobuf field");
    if (tag % 8 === 0) {
      result[tag >> 3] = readVarint();
    } else {
      assert.equal(tag % 8, 2, "Unexpected fixture protobuf wire type");
      const length = readVarint();
      const end = offset + length;
      assert.ok(end <= body.length, "Truncated fixture protobuf field");
      result[tag >> 3] = body.subarray(offset, end);
      offset = end;
    }
  }
  return result;
}

const emptyRoutes = new Set([
  "POST /aiserver.v1.ServerConfigService/GetServerConfig",
  "POST /aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "POST /aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
  "POST /aiserver.v1.AnalyticsService/TrackEvents",
]);

// These field numbers are the SDK 1.4.2 loopback contract. Shell execution
// requires both the command and the model-supplied parsed command.
function shellMessages(workspace) {
  const arg = (value) => bytes(2, join(bytes(1, "word"), bytes(2, value)));
  const command = "sh cursor-canary.sh";
  const parsed = join(
    bytes(2, join(bytes(1, "sh"), arg("cursor-canary.sh"), bytes(3, command))),
    number(3, 1),
  );
  const args = join(
    bytes(1, command),
    bytes(2, workspace),
    number(3, 15000),
    bytes(4, callId),
    number(7, 1),
    bytes(8, parsed),
  );
  const update = (field, result = Buffer.alloc(0)) =>
    interaction(field, join(bytes(1, callId), bytes(2, bytes(1, join(bytes(1, args), result)))));
  return {
    started: update(2),
    execute: frame(bytes(2, join(number(1, 23), bytes(15, callId), bytes(2, args)))),
    finished: (result) => update(3, bytes(2, result)),
  };
}

export async function startBackend(workspace, { allowCodexPrewarm }) {
  const shell = shellMessages(workspace);
  const streams = new Map();
  const failures = [];
  let runs = 0;
  let shellReplies = 0;
  const nextSteer = [];
  const steers = [];

  function sendSteerAck(key, injection, send) {
    const payload = fields(injection);
    const id = payload[1].toString();
    const user = fields(payload[3])[1];
    const text = fields(user)[1].toString();
    const expected = nextSteer.shift();
    assert.ok(expected, "Unexpected native steer request");
    assert.equal(text, expected.text);
    const stream = streams.get(key);
    assert.ok(stream && !stream.writableEnded, "Steer has no active native run");
    steers.push({ text, outcome: expected.outcome });
    send(proto);
    // The pinned SDK maps context injection delivery to native ownership
    // and an explicit rejection to a client-owned follow-up.
    if (expected.outcome === "delivered") stream.write(interaction(6, bytes(1, user)));
    stream.write(
      interaction(
        23,
        join(
          bytes(1, id),
          bytes(
            2,
            expected.outcome === "delivered"
              ? bytes(2, number(1, 1))
              : bytes(5, bytes(1, "fixture fallback")),
          ),
        ),
      ),
    );
  }

  function handleBidiAppend(body, send) {
    const outer = fields(body);
    const nested = outer[4] ?? Buffer.from(outer[1]?.toString() ?? "", "hex");
    const client = fields(nested);
    const injection = client[4] && fields(client[4])[19];
    if (injection) {
      const key = fields(outer[2])[1].toString();
      sendSteerAck(key, injection, send);
      return;
    }
    const exec = client[2];
    const reply = exec && fields(exec);
    const result = reply?.[2];
    if (!result) return send(proto);
    const key = fields(outer[2])[1].toString();
    const stream = streams.get(key);
    assert.ok(stream && !stream.writableEnded, "Shell reply has no active run");
    const decoded = fields(result);
    assert.ok(Buffer.isBuffer(decoded[1]), "SDK shell did not report success");
    assert.ok(
      Object.keys(decoded).every((field) => field === "1" || field === "101"),
      "Unexpected SDK shell result case",
    );
    shellReplies++;
    send(proto);
    stream.write(shell.finished(result));
    stream.write(interaction(1, bytes(1, assistantText)));
    stream.write(interaction(14, join(number(1, 12), number(2, 3), number(3, 2))));
    stream.end(frame(Buffer.from("{}"), 2));
    return;
  }

  const server = createServer(async (request, response) => {
    const route = `${request.method} ${request.url}`;
    const send = (type, payload) => response.writeHead(200, { "content-type": type }).end(payload);
    const auth = (value) => assert.equal(request.headers.authorization, `Bearer ${value}`);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = join(...chunks);
      switch (route) {
        case "GET /codex/v1/responses":
          assert.ok(allowCodexPrewarm, "Unexpected Codex prewarm in the routine fixture");
          assert.equal(request.headers.upgrade, "websocket");
          assert.equal(request.headers.authorization, undefined);
          console.log("PASS refused unauthenticated Codex prewarm handshake on loopback");
          return response.writeHead(403).end();
        case "POST /auth/exchange_user_api_key":
          auth(apiKey);
          return send("application/json", JSON.stringify({ accessToken: token }));
        case "GET /v1/models":
          auth(apiKey);
          return send(
            "application/json",
            JSON.stringify({ items: [{ id: model, displayName: model }] }),
          );
        case "POST /aiserver.v1.DashboardService/GetUserPrivacyMode":
          return send(proto, number(1, 1));
        case "POST /aiserver.v1.AnalyticsService/BootstrapStatsig":
          return send("application/json", "{}");
        case "POST /agent.v1.AgentService/RunSSE": {
          auth(token);
          assert.equal(request.headers["content-type"], connect);
          assert.equal(body[0], 0);
          assert.equal(body.readUInt32BE(1), body.length - 5);
          const key = fields(body.subarray(5))[1]?.toString();
          assert.ok(key, "Missing fixture run key");
          assert.ok(!streams.has(key), "Duplicate fixture run key");
          runs++;
          streams.set(key, response);
          response.on("close", () => streams.delete(key));
          response.writeHead(200, { "content-type": connect });
          response.write(shell.started);
          response.write(shell.execute);
          return;
        }
        case "POST /aiserver.v1.BidiService/BidiAppend":
          return handleBidiAppend(body, send);
        default:
          if (emptyRoutes.has(route)) return send(proto);
          throw new Error("Unexpected loopback route");
      }
    } catch (error) {
      failures.push(`${route}: ${error.message}`);
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end("Cursor fixture mismatch");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get runs() {
      return runs;
    },
    get shellReplies() {
      return shellReplies;
    },
    expectSteer(text, outcome) {
      nextSteer.push({ text, outcome });
    },
    get steers() {
      return steers.slice();
    },
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
      assert.deepEqual(nextSteer, [], "Expected SDK steer requests were not received");
      assert.deepEqual(
        failures,
        [],
        "Cursor fixture received unexpected requests or invalid frames",
      );
    },
  };
}
