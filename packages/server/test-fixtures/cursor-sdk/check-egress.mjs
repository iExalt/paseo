import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const trace = await readFile(process.argv[2], "utf8");
for (const line of trace.split("\n")) {
  for (const match of line.matchAll(/sa_family=AF_INET(6)?,[^}]*}/g)) {
    const allowed = match[1] ? /inet_pton\(AF_INET6, "::1"/ : /inet_addr\("127\.0\.0\.1"\)/;
    assert.match(match[0], allowed, `Unexpected Internet destination: ${line}`);
  }
}
assert.match(trace, /sa_family=AF_INET,.*"127\.0\.0\.1"/, "Missing fixture loopback traffic");
console.log("PASS native egress preflight and loopback-only process tree");
