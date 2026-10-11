const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function validateNixLinuxLayout({ desktop, daemon, version }) {
  assert.equal(process.platform, "linux");
  for (const root of [desktop, daemon]) {
    assert.match(root, /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/);
    assert.equal(fs.realpathSync(root), root, "Use canonical evaluated Nix outputs");
  }
  const appRoot = path.join(desktop, "share/paseo-desktop/electron-app");
  const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "paseo-desktop");
  assert.equal(metadata.version, version);
  assert.equal(metadata.main, "index.js");
  assert.equal(
    fs.readFileSync(path.join(appRoot, "index.js"), "utf8").trim(),
    'require("../packages/desktop/dist/main.js");',
  );
  const entry = fs.readFileSync(
    path.join(desktop, "share/applications/paseo-desktop.desktop"),
    "utf8",
  );
  for (const line of [
    "Name=Paseo",
    "Exec=paseo-desktop",
    "Icon=paseo-desktop",
    "StartupWMClass=paseo-desktop",
  ])
    assert.ok(entry.split("\n").includes(line), `Missing desktop entry ${line}`);
  const daemonMetadata = JSON.parse(
    fs.readFileSync(path.join(daemon, "lib/paseo/package.json"), "utf8"),
  );
  assert.equal(daemonMetadata.version, version);
  const executablePath = path.join(desktop, "bin/paseo-desktop");
  const cliPath = path.join(daemon, "bin/paseo");
  for (const executable of [executablePath, cliPath]) fs.accessSync(executable, fs.constants.X_OK);
  return { executablePath, cliPath };
}

module.exports = { validateNixLinuxLayout };
