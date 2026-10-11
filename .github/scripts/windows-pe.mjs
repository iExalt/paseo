import assert from "node:assert/strict";

// Read only the PE facts needed to reject a wrong architecture or a binding
// linked to a separate Node executable. Native loading remains a separate gate.
export function inspectPe(bytes) {
  assert.equal(bytes.toString("ascii", 0, 2), "MZ", "DOS signature");
  const header = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", header, header + 4), "PE\0\0", "PE signature");
  const machine = bytes.readUInt16LE(header + 4);
  const sectionCount = bytes.readUInt16LE(header + 6);
  const optionalSize = bytes.readUInt16LE(header + 20);
  const optional = header + 24;
  assert.equal(bytes.readUInt16LE(optional), 0x20b, "64-bit PE required");
  assert.ok(optionalSize >= 112 + 14 * 8, "Import directories required");
  assert.ok(bytes.readUInt32LE(optional + 108) >= 14, "Delay directory required");
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const position = optional + optionalSize + index * 40;
    sections.push({
      rva: bytes.readUInt32LE(position + 12),
      size: bytes.readUInt32LE(position + 16),
      offset: bytes.readUInt32LE(position + 20),
    });
  }
  function offset(rva, size) {
    const section = sections.find(
      (entry) => rva >= entry.rva && rva + size <= entry.rva + entry.size,
    );
    assert.ok(section, "RVA must map to file-backed section");
    const result = section.offset + rva - section.rva;
    assert.ok(result + size <= bytes.length, "Truncated PE section");
    return result;
  }
  function name(rva) {
    let result = "";
    for (let index = 0; index < 256; index++) {
      const value = bytes[offset(rva + index, 1)];
      if (value === 0) return result.toLowerCase();
      assert.ok(value >= 32 && value <= 126, "ASCII import name required");
      result += String.fromCharCode(value);
    }
    throw new Error("Unterminated import name");
  }
  function imports(directoryIndex, stride, nameOffset, delayed) {
    const directory = optional + 112 + directoryIndex * 8;
    const rva = bytes.readUInt32LE(directory);
    const size = bytes.readUInt32LE(directory + 4);
    if (rva === 0 && size === 0) return [];
    assert.ok(rva > 0 && size >= stride, "Invalid import directory");
    const result = [];
    for (let index = 0; index + stride <= size; index += stride) {
      const position = offset(rva + index, stride);
      if (bytes.subarray(position, position + stride).every((value) => value === 0)) return result;
      if (delayed) assert.equal(bytes.readUInt32LE(position), 1, "RVA delay imports required");
      result.push(name(bytes.readUInt32LE(position + nameOffset)));
    }
    throw new Error("Unterminated import directory");
  }
  return { machine, imports: imports(1, 20, 12, false), delayedImports: imports(13, 32, 4, true) };
}

export function assertElectronArmBinding(bytes) {
  const identity = inspectPe(bytes);
  assert.equal(identity.machine, 0xaa64, "ARM64 binding required");
  assert.ok(
    !identity.imports.some((name) => /^(node|electron)\.(exe|dll)$/.test(name)),
    "Node must not be a normal import",
  );
  assert.ok(
    identity.delayedImports.includes("node.exe"),
    "Electron delay-load hook target required",
  );
  return identity;
}
