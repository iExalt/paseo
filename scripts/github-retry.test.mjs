import assert from "node:assert/strict";
import test from "node:test";
import {
  replaceRetryPause,
  retryingFetch,
  retryingGhRead,
} from "../.github/scripts/github-retry.mjs";

const pauses = [];
test.after(
  replaceRetryPause(
    async (ms) => pauses.push(ms),
    (ms) => pauses.push(ms),
  ),
);
const reply = (status) => new Response(status === 200 ? "{}" : "error", { status });

test("reads retry transient server errors and network faults within a bound", async () => {
  pauses.length = 0;
  const statuses = [500, 502, 200];
  const calls = [];
  const read = retryingFetch(async (url, options) => {
    calls.push(options.method);
    return reply(statuses.shift());
  });
  assert.equal((await read("https://api.github.com/x")).status, 200);
  assert.deepEqual(pauses, [2000, 5000]);
  assert.equal(calls.length, 3);

  pauses.length = 0;
  let thrown = 0;
  const flaky = retryingFetch(async () => {
    if (thrown++ === 0) throw new TypeError("fetch failed");
    return reply(200);
  });
  assert.equal((await flaky("https://api.github.com/x")).status, 200);

  pauses.length = 0;
  let attempts = 0;
  const down = retryingFetch(async () => (attempts++, reply(503)));
  assert.equal((await down("https://api.github.com/x")).status, 503);
  assert.equal(attempts, 3);
});

test("client errors, writes and expired deadlines are never retried", async () => {
  pauses.length = 0;
  let attempts = 0;
  const count = async () => (attempts++, reply(500));
  assert.equal((await retryingFetch(async () => (attempts++, reply(404)))("u")).status, 404);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"])
    assert.equal((await retryingFetch(count)("u", { method })).status, 500);
  assert.equal(attempts, 5);
  const signal = AbortSignal.abort();
  await assert.rejects(
    retryingFetch(async () => {
      attempts++;
      throw signal.reason;
    })("u", { signal }),
  );
  assert.equal(attempts, 6);
  assert.deepEqual(pauses, []);
});

test("gh reads retry only reported 5xx and timeouts", () => {
  pauses.length = 0;
  const failure = (stderr, code) => Object.assign(new Error("Command failed"), { stderr, code });
  const outcomes = [failure("gh: HTTP 500\n"), failure("", "ETIMEDOUT"), "ok"];
  const read = retryingGhRead(() => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  assert.equal(read("/repos/x"), "ok");
  assert.deepEqual(pauses, [2000, 5000]);
  let attempts = 0;
  const missing = retryingGhRead(() => {
    attempts++;
    throw failure("gh: Not Found (HTTP 404)\n");
  });
  assert.throws(() => missing("/repos/x"), /Command failed/);
  const down = retryingGhRead(() => {
    attempts++;
    throw failure("gh: HTTP 502\n");
  });
  assert.throws(() => down("/repos/x"), /Command failed/);
  assert.equal(attempts, 4);
});
