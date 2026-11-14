//   node release-manifest.mjs build <assets dir>   writes primary and desktop .json/.sig inventories
import { validateDesktopReleaseManifest } from "../../packages/protocol/src/desktop-release-manifest.ts";
import { verifyDesktopReleaseBytes } from "../../scripts/desktop-release.mjs";
  verifyBytes = verifyReleaseManifestBytes,
  verifyBytes(bytes, signature, publicPin);
export function desktopManifestBytes(primaryBytes, { windows, linux }) {
  const primary = JSON.parse(primaryBytes);
  const { schemaVersion: _schema, artifacts: _artifacts, ...identity } = primary;
  const manifest = {
    schemaVersion: 1,
    ...identity,
    primaryManifestSha256: createHash("sha256").update(primaryBytes).digest("hex"),
    artifacts: [windows, ...linux],
  };
  validateDesktopReleaseManifest(manifest, primary);
  return Buffer.from(`${JSON.stringify(manifest)}\n`);
}

export function buildReleaseManifests(
  directory,
  env,
  publicPin = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  const signature = signManifest(bytes, env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY, publicPin);
  const installer = read(names.windowsInstaller);
  const desktopBytes = desktopManifestBytes(bytes, {
    windows: {
      platform: "windows",
      arch: "x64",
      kind: "nsis",
      ...describeAsset(names.windowsInstaller, installer),
      sha512: createHash("sha512").update(installer).digest("base64"),
    },
    linux: ["x64", "arm64"].map((arch) => {
      const archiveName = arch === "x64" ? names.linuxX64Archive : names.linuxArm64Archive;
      const closureName = arch === "x64" ? names.linuxX64Closure : names.linuxArm64Closure;
      const linuxClosureBytes = read(closureName);
      const closure = JSON.parse(linuxClosureBytes);
      const artifact = Object.assign(describeAsset(archiveName, read(archiveName)), {
        platform: "linux",
        arch,
        kind: "nix-desktop",
        system: arch === "x64" ? "x86_64-linux" : "aarch64-linux",
        outputPath: closure.outputPath,
        outputPaths: closure.outputPaths,
        closureManifest: describeAsset(closureName, linuxClosureBytes),
      });
      validateNixArtifactClosure(linuxClosureBytes, artifact, JSON.parse(bytes));
      assert.ok(
        artifact.outputPaths.every((output) =>
          closure.closure.some((entry) => entry.path === output),
        ),
        "Linux closure omits an output",
      );
      return artifact;
    }),
  });
  const desktopSignature = signManifest(
    desktopBytes,
    env.PASEO_RELEASE_MANIFEST_PRIVATE_KEY,
    publicPin,
    (data, sig, pin) => verifyDesktopReleaseBytes(data, sig, bytes, signature, pin),
  );
  writeFileSync(join(directory, names.desktopManifest), desktopBytes, { flag: "wx" });
  writeFileSync(join(directory, names.desktopSignature), desktopSignature, { flag: "wx" });
  if (command === "build") buildReleaseManifests(argument, process.env);
