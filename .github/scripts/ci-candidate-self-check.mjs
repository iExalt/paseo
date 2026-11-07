import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [target, directory] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.ok(["controller", "controller-failure"].includes(target));
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sourceSha, process.env.SOURCE_SHA);
const { kind, marker } = JSON.parse(readFileSync(".github/candidate-proof.json", "utf8"));
assert.equal(kind, "paseo-candidate-self-check");
writeFileSync(
  resolve(directory, "candidate-result.json"),
  JSON.stringify({ sourceSha, marker, target }) + "\n",
);
console.log(`Candidate self-check ${sourceSha} marker=${marker}`);
if (target === "controller-failure") process.exitCode = 17;
