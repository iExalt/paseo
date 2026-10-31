import assert from "node:assert/strict";
import test from "node:test";
import { buildQaWebConfig, checkQaWebHome, parseQaWebArgs, qaWebEnv } from "./qa-web-config.mjs";

test("the scratch config turns off the relay, usage, plugins, speech and every provider but mock", () => {
  const providerIds = ["claude", "codex", "future-provider", "mock", "mock-slow"];
  const config = buildQaWebConfig({ port: 7812, providerIds });

  assert.equal(config.daemon.listen, "127.0.0.1:7812");
  assert.deepEqual(config.daemon.relay, { enabled: false });
  assert.deepEqual(config.daemon.usage, { enabled: false });
  assert.equal(config.pluginsEnabled, false);
  assert.equal(config.features.webUi.enabled, true);
  assert.equal(config.features.dictation.enabled, false);
  assert.equal(config.features.voiceMode.enabled, false);
  assert.deepEqual(
    Object.entries(config.agents.providers)
      .filter(([, provider]) => provider.enabled)
      .map(([id]) => id),
    ["mock"],
  );
  assert.deepEqual(Object.keys(config.agents.providers).sort(), providerIds);
});

test("children get the scratch home and development mode, and no inherited PASEO_ keys", () => {
  const env = qaWebEnv(
    {
      PATH: "/bin",
      PASEO_HOME: "/real",
      PASEO_HOST: "x:6767",
      PASEO_AGENT_ID: "a",
      PASEO_LISTEN: "y",
    },
    "/scratch",
  );
  assert.deepEqual(env, { PATH: "/bin", PASEO_HOME: "/scratch", PASEO_NODE_ENV: "development" });
});

test("the home guard refuses real daemon homes and existing configs", () => {
  const base = {
    env: { PASEO_HOME: "/agent/home" },
    homeDir: "/u",
    hasConfig: false,
    reuse: false,
  };
  assert.throws(() => checkQaWebHome({ ...base, home: "/u/.paseo" }), /real daemon home/);
  assert.throws(() => checkQaWebHome({ ...base, home: "/agent/home/" }), /real daemon home/);
  assert.throws(() => checkQaWebHome({ ...base, home: "/s", hasConfig: true }), /--reuse/);
  assert.deepEqual(checkQaWebHome({ ...base, home: "/s", hasConfig: true, reuse: true }), []);
  assert.match(checkQaWebHome({ ...base, home: `/${"d".repeat(100)}` })[0], /Unix socket/);
});

test("arguments parse into start and stop modes and reject the unknown", () => {
  assert.deepEqual(parseQaWebArgs(["--seed", "heavy", "--port", "7812"]), {
    mode: "start",
    home: null,
    port: 7812,
    seed: "heavy",
    reuse: false,
  });
  assert.equal(parseQaWebArgs(["--stop", "/h"]).mode, "stop");
  assert.throws(() => parseQaWebArgs(["--seed", "light"]), /only "heavy"/);
  assert.throws(() => parseQaWebArgs(["--port", "0"]), /Invalid --port/);
  assert.throws(() => parseQaWebArgs(["--home"]), /needs a value/);
  assert.throws(() => parseQaWebArgs(["--bogus"]), /Unknown option/);
});
