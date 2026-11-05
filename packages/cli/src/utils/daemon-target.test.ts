import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { test, expect } from "vitest";
import { selectDaemonTarget, describeDaemonTarget } from "./daemon-target.js";
import {
  resolveDaemonCredential,
  resolveClientPaseoHome,
  buildDaemonConnectionCommandError,
} from "./client.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("explicit selectors win over both environment selectors", () => {
  const env = { PASEO_HOME: "/tmp/a", PASEO_HOST: "unused:12345" };
  expect(selectDaemonTarget({ home: "/tmp/b" }, env)).toEqual({ kind: "instance", home: "/tmp/b" });
  expect(selectDaemonTarget({ host: "chosen:23456" }, env)).toEqual({
    kind: "endpoint",
    host: "chosen:23456",
  });
  expect(() => selectDaemonTarget({}, env)).toThrow();
  expect(() => selectDaemonTarget({ home: "/tmp/b", host: "chosen:23456" }, {})).toThrow();
});

test("uses the owned home when a managed agent clears inherited host selection", () => {
  expect(selectDaemonTarget({}, { PASEO_HOME: "/tmp/owned-home", PASEO_HOST: "" })).toEqual({
    kind: "instance",
    home: "/tmp/owned-home",
  });
});

test("endpoint connections resolve local credentials from PASEO_HOME", () => {
  expect(
    resolveClientPaseoHome(
      { kind: "endpoint", host: "localhost:6767" },
      { PASEO_HOME: "/tmp/custom-home" },
    ),
  ).toBe("/tmp/custom-home");
});

test("local operations ignore routing environment but reject an explicit endpoint", () => {
  expect(
    selectDaemonTarget({}, { PASEO_HOME: "/tmp/b", PASEO_HOST: "unused:12345" }, true),
  ).toEqual({ kind: "instance", home: "/tmp/b" });
  expect(() => selectDaemonTarget({ host: "chosen:23456" }, {}, true)).toThrow();
});

test("endpoint descriptions redact pairing material and credentials", () => {
  expect(
    describeDaemonTarget({
      kind: "endpoint",
      host: "tcp://user:private@example.test:23456?password=secret",
    }),
  ).not.toMatch(/private|secret/);
  expect(
    describeDaemonTarget({ kind: "endpoint", host: "https://app.paseo.sh/#offer=private" }),
  ).not.toContain("private");
});

test("a pairing offer without a URL prefix still redacts its key", () => {
  const offer = {
    v: 2,
    serverId: "srv_example",
    daemonPublicKeyB64: "example-secret",
    relay: { endpoint: "localhost:6767", useTls: false },
  };
  const host = `#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
  expect(describeDaemonTarget({ kind: "endpoint", host })).toBe(
    "relay://localhost:6767/srv_example",
  );
});

test("malformed endpoint diagnostics never expose the supplied credential", () => {
  const target = { kind: "endpoint" as const, host: "alice:example-secret@localhost:6767" };
  expect(describeDaemonTarget(target)).not.toContain("example-secret");
  for (const message of [
    `Invalid connection ${target.host}`,
    `Cannot connect to daemon at ${target.host}`,
  ]) {
    const diagnostic = buildDaemonConnectionCommandError({ target, error: new Error(message) });
    expect(JSON.stringify(diagnostic)).not.toContain("example-secret");
  }
});

test.each(["EPERM", "EACCES"])(
  "%s preserves the permission failure without start advice",
  (code) => {
    const diagnostic = buildDaemonConnectionCommandError({
      target: { kind: "instance", home: "/tmp/selected-home" },
      error: Object.assign(new Error("Operation not permitted"), { code }),
    });
    expect(diagnostic).toEqual({
      code,
      message: "Cannot connect to daemon at home /tmp/selected-home: Operation not permitted",
      details:
        "Permission denied while accessing the selected daemon or probing this system. Check this command's filesystem, process and network access.",
    });
  },
);

test("system-probe permission failures retain their system code and access remedy", () => {
  const diagnostic = buildDaemonConnectionCommandError({
    target: { kind: "instance", home: "/tmp/selected-home" },
    error: Object.assign(new Error("uv_uptime returned EPERM (operation not permitted)"), {
      code: "ERR_SYSTEM_ERROR",
      info: { code: "EPERM", syscall: "uv_uptime" },
    }),
  });
  expect(diagnostic.code).toBe("ERR_SYSTEM_ERROR");
  expect(diagnostic.message).toBe(
    "Cannot connect to daemon at home /tmp/selected-home: uv_uptime returned EPERM (operation not permitted)",
  );
  expect(diagnostic.details).toBe(
    "Permission denied while accessing the selected daemon or probing this system. Check this command's filesystem, process and network access.",
  );
});

test("connection diagnostics preserve structured messages and intentional details when wrapped again", () => {
  const target = { kind: "instance" as const, home: "/tmp/selected-home" };
  const failure = {
    code: "AUTH_REQUIRED",
    message: "Cannot connect to daemon at home /tmp/selected-home: Password required",
    details: "Set PASEO_PASSWORD and retry.",
  };
  expect(buildDaemonConnectionCommandError({ target, error: failure })).toEqual(failure);
});

test.each([
  ["DAEMON_NOT_RUNNING", true],
  ["ERR_SYSTEM_ERROR", false],
  ["ECONNREFUSED", false],
  ["DAEMON_REQUEST_TIMEOUT", false],
])("only a confirmed absent daemon suggests starting it: %s", (code, startAdvice) => {
  const diagnostic = buildDaemonConnectionCommandError({
    target: { kind: "instance", home: "/tmp/selected-home" },
    error: { code, message: "Connection failed" },
  });
  expect(String(diagnostic.details).includes("paseo daemon start")).toBe(startAdvice);
});

test("CLI selects an explicit password before a matching local credential and never sends the latter remotely", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-cli-credential-"));
  const previousPassword = process.env.PASEO_PASSWORD;
  delete process.env.PASEO_PASSWORD;
  try {
    const token = "a".repeat(43);
    await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
    await writeFile(join(home, "local-credential"), token);
    expect(resolveDaemonCredential("tcp://localhost:6767", home)).toEqual({
      kind: "localCredential",
      token,
    });
    expect(resolveDaemonCredential("tcp://remote.example:6767", home)).toBeNull();
    expect(resolveDaemonCredential("tcp://localhost:6767?password=explicit", home)).toEqual({
      kind: "password",
      password: "explicit",
    });
  } finally {
    if (previousPassword === undefined) delete process.env.PASEO_PASSWORD;
    else process.env.PASEO_PASSWORD = previousPassword;
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["/tmp/paseo.sock", "\\\\.\\pipe\\paseo", "localhost:6767", "[::1]:6767", "6767"])(
  "validated bare target %s keeps its spelling in command hints",
  (host) => {
    expect(describeDaemonTarget({ kind: "endpoint", host })).toBe(host);
  },
);

test("validated URI command hints preserve their transport address without credentials", () => {
  const ssh = describeDaemonTarget({
    kind: "endpoint",
    host: "ssh://deploy@build-box:2222?daemonPort=7777&password=example-secret",
  });
  expect(ssh).not.toContain("example-secret");
  expect(parseHostTarget(ssh)).toMatchObject({
    kind: "ssh",
    ssh: { host: "deploy@build-box", sshPort: 2222, daemonPort: 7777 },
  });
  const ws = describeDaemonTarget({
    kind: "endpoint",
    host: "wss://example.test/custom-ws?authorization=example-secret",
  });
  expect(ws).not.toContain("example-secret");
  expect(new URL(ws).pathname).toBe("/custom-ws");
  expect(
    describeDaemonTarget({
      kind: "endpoint",
      host: "tcp://localhost:6767?daemonPort=example-secret&ssl=example-secret",
    }),
  ).not.toContain("example-secret");
});
