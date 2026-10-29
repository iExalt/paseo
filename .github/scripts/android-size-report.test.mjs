import assert from "node:assert/strict";
import test from "node:test";
import { sizeReport, zipEntries } from "./android-size-report.mjs";

// A stored (uncompressed) zip with no CRCs: enough for the central directory reader.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, size] of files) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, Buffer.alloc(size));
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("the APK size report groups stored bytes and lists the downloads", () => {
  const entries = zipEntries(
    zip([
      ["lib/arm64-v8a/libbig.so", 3_000_000],
      ["classes.dex", 1_000_000],
      ["classes2.dex", 500_000],
      ["assets/index.android.bundle", 2_000_000],
      ["assets/fonts/a.ttf", 100_000],
      ["res/raw/x.bin", 200_000],
      ["AndroidManifest.xml", 10_000],
    ]),
  );
  assert.equal(entries.length, 7);
  assert.deepEqual(entries[0], { name: "lib/arm64-v8a/libbig.so", stored: 3_000_000 });
  const report = sizeReport(entries, [{ name: "x.apk.gz", bytes: 2_500_000 }]);
  for (const row of [
    "| Native libraries | 3.0 MB |",
    "| Dex | 1.5 MB |",
    "| JS bundle | 2.0 MB |",
    "| Other assets | 0.1 MB |",
    "| Resources | 0.2 MB |",
    "| Other | 0.0 MB |",
    "| `lib/arm64-v8a/libbig.so` | 3.0 MB |",
    "| `x.apk.gz` | 2.5 MB |",
  ])
    assert.ok(report.includes(row), row);
  assert.throws(() => zipEntries(Buffer.alloc(100)), /no zip end record/);
});
