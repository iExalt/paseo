const fs = require("node:fs");
const path = require("node:path");

// Keep one pre-Chromium entrypoint for AppRun, desktop entries, updates, and tarballs.
exports.installLinuxLauncher = function installLinuxLauncher(appOutDir) {
  const launcher = path.join(appOutDir, "Paseo");
  if (!fs.existsSync(`${launcher}.bin`)) {
    fs.renameSync(launcher, `${launcher}.bin`);
  }
  fs.copyFileSync(path.join(__dirname, "launcher.sh"), launcher);
  fs.chmodSync(launcher, 0o755);
  exports.installLinuxPackageHook(appOutDir, "Paseo", "Paseo");
};

exports.installLinuxPackageHook = function installLinuxPackageHook(
  appOutDir,
  executable,
  productName,
) {
  for (const name of [executable, productName]) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) throw new Error("Invalid Linux package name");
  }
  const script = fs
    .readFileSync(path.join(__dirname, "after-install.tpl"), "utf8")
    .replaceAll("${executable}", executable)
    .replaceAll("${sanitizedProductName}", productName);
  const destination = path.join(appOutDir, "resources/linux-after-install.sh");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, script, { mode: 0o644 });
};
