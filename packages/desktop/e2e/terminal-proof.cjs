const assert = require("node:assert/strict");

function terminalHookCommand(marker, platform = process.platform) {
  assert.match(marker, /^[a-zA-Z0-9-]+$/);
  const middle = Math.floor(marker.length / 2);
  const left = marker.slice(0, middle);
  const right = marker.slice(middle);
  assert.ok(left && right);
  if (platform === "win32") {
    const script = [
      "& $env:PASEO_HOOK_CLI hooks codex Stop",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      `Write-Output ('${left}' + '${right}')`,
    ].join("; ");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return `"$PASEO_HOOK_CLI" hooks codex Stop && printf '%s%s\\n' '${left}' '${right}'`;
}

function hasTerminalOutput(lines, marker) {
  return lines.some((line) => typeof line === "string" && line.trim() === marker);
}

module.exports = { terminalHookCommand, hasTerminalOutput };
