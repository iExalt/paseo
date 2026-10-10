// Stable fork versions are authoritative. Android's integer is only an encoding
// required by the package manager, never an independently allocated build ID.
export function parseForkVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Fork version must be canonical stable semver.");
  }
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("Fork version component exceeds the safe integer range.");
  }
  return parts;
}

export function compareForkVersions(left, right) {
  const a = parseForkVersion(left);
  const b = parseForkVersion(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function forkAndroidVersionCode(version) {
  const [major, minor, patch] = parseForkVersion(version);
  if (minor >= 1000 || patch >= 1000) {
    throw new Error("Android encoding requires minor and patch below 1000.");
  }
  // The fixed offset preserves same-certificate manual installation over legacy
  // 200008. It must never be recalculated from runs, retries, or release history.
  const code = 200_000 + major * 1_000_000 + minor * 1000 + patch;
  if (!Number.isSafeInteger(code) || code > 2_100_000_000) {
    throw new Error("Fork version exceeds Android's versionCode range.");
  }
  return code;
}
