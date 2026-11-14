// Prints a Markdown size table for the signed APK and its download sidecars, for the
// release job summary: what each part of the APK weighs, and what a phone downloads.
// Usage: node android-size-report.mjs <signed APK> [<directory with deltas>...]
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GROUPS = [
  ["Native libraries", (name) => name.startsWith("lib/")],
  ["Dex", (name) => /^classes\d*\.dex$/.test(name)],
  ["JS bundle", (name) => name === "assets/index.android.bundle"],
  ["Other assets", (name) => name.startsWith("assets/")],
  ["Resources", (name) => name.startsWith("res/") || name === "resources.arsc"],
  ["Other", () => true],
];

/** Reads the name and stored size of every entry from a zip's central directory. */
export function zipEntries(bytes) {
  const minEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let end = bytes.length - 22;
  while (end >= minEnd && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= minEnd, "APK has no zip end record");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "APK central directory is corrupt");
    const stored = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({ name, stored });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function sizeReport(entries, downloads) {
  const totals = new Map(GROUPS.map(([group]) => [group, 0]));
  for (const { name, stored } of entries) {
    const [group] = GROUPS.find(([, matches]) => matches(name));
    totals.set(group, totals.get(group) + stored);
  }
  const largest = entries.toSorted((a, b) => b.stored - a.stored).slice(0, 8);
  return [
    "### Android APK size",
    "",
    "| Part | Stored in APK |",
    "| --- | --- |",
    ...[...totals].map(([group, bytes]) => `| ${group} | ${mb(bytes)} |`),
    "",
    "| Largest entries | Stored in APK |",
    "| --- | --- |",
    ...largest.map(({ name, stored }) => `| \`${name}\` | ${mb(stored)} |`),
    "",
    "| Download | Size |",
    "| --- | --- |",
    ...downloads.map(({ name, bytes }) => `| \`${name}\` | ${mb(bytes)} |`),
    "",
  ].join("\n");
}

async function main() {
  const [apk, ...deltaDirectories] = process.argv.slice(2);
  const downloads = [];
  for (const file of [apk, `${apk}.gz`]) {
    downloads.push({ name: basename(file), bytes: (await stat(file)).size });
  }
  for (const directory of deltaDirectories) {
    const names = await readdir(directory).catch(() => []);
    for (const name of names.filter((entry) => entry.includes(".apk.delta-from-")).sort()) {
      downloads.push({ name, bytes: (await stat(join(directory, name))).size });
    }
  }
  process.stdout.write(sizeReport(zipEntries(await readFile(apk)), downloads));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
