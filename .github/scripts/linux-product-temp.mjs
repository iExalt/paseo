import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const stages = {
  "appimage-previous": "ap",
  "appimage-candidate": "ac",
  "deb-previous": "dp",
  "deb-candidate": "dc",
};

export function validateTemporaryRoot(record) {
  assert.match(record.path, /^\/tmp\/paseo-[A-Za-z0-9]{6}$/);
  assert.equal(record.uid, process.getuid());
  assert.equal(realpathSync(record.path), record.path);
  const stat = lstatSync(record.path);
  assert.ok(stat.isDirectory());
  assert.equal(stat.uid, record.uid);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.dev, record.dev);
  assert.equal(stat.ino, record.ino);
  return record;
}

export function stageTemporaryDirectory(record, stage) {
  assert.ok(Object.hasOwn(stages, stage));
  const directory = join(record.path, stages[stage]);
  assert.ok(Buffer.byteLength(`${directory}/scoped_dirXXXXXX/SingletonSocket`) < 108);
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, stage] = process.argv.slice(2);
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(realpathSync(root), root);
  assert.equal(readFileSync(join(root, "owned"), "utf8").trim(), process.env.GITHUB_SHA);
  const receipt = join(root, "temporary-root.json");
  if (stage === "create") {
    const directory = mkdtempSync("/tmp/paseo-");
    const stat = lstatSync(directory);
    const record = validateTemporaryRoot({
      path: directory,
      uid: stat.uid,
      dev: stat.dev,
      ino: stat.ino,
    });
    writeFileSync(receipt, JSON.stringify(record), { flag: "wx" });
  } else {
    const record = validateTemporaryRoot(JSON.parse(readFileSync(receipt)));
    console.log(stageTemporaryDirectory(record, stage));
  }
}
