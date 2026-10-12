param([Parameter(Mandatory = $true)][ValidateSet('init', 'install-candidate', 'install-previous', 'binding', 'build-candidate', 'build-previous', 'cleanup', 'diagnostics')][string]$Phase)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$candidateSha = if ($env:PASEO_CANDIDATE_SHA) { $env:PASEO_CANDIDATE_SHA } else { $env:GITHUB_SHA }
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -ne 'iExalt/paseo' -or $env:GITHUB_REF -ne 'refs/heads/dev' -or $env:GITHUB_ACTOR -ne 'iExalt') {
    throw 'Trusted hosted Windows dev run required'
}
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') { throw 'Invalid run identity' }
$root = Join-Path $env:RUNNER_TEMP "paseo-windows-products-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
$evidence = Join-Path $root 'evidence'
$node = (Get-Command node.exe).Source
$pwsh = (Get-Process -Id $PID).Path
. (Join-Path $PSScriptRoot 'windows-native-toolchain.ps1')
if ($Phase -eq 'init') {
    if (Test-Path -LiteralPath $root) { throw 'Refuse reused product root' }
    if ((git rev-parse HEAD).Trim() -ne $candidateSha -or (git status --porcelain)) { throw 'Exact clean checkout required' }
    git cat-file -e '5619b7d7ee1e55b322028e8b7818aa1a8f752a0a^{commit}'
    if ($LASTEXITCODE -ne 0) { throw 'Full history containing fixed predecessor required' }
    if ((& $node -p 'process.version') -ne 'v26.11.0' -or (& $node -p 'process.arch') -ne $env:EXPECTED_ARCHITECTURE) { throw 'Native pinned Node required' }
    New-Item -ItemType Directory -Path $root, $evidence, (Join-Path $root 'logs') | Out-Null
} elseif (!(Test-Path -LiteralPath $root)) {
    if ($Phase -eq 'cleanup') { exit 0 }
    throw 'Product root missing'
}

if ($Phase -eq 'diagnostics') {
    foreach ($log in @(Get-ChildItem -LiteralPath (Join-Path $root 'logs') -Filter '*.log' -File)) {
        Get-Content -LiteralPath $log.FullName -Tail 200 | Set-Content -LiteralPath (Join-Path $evidence "$($log.BaseName)-tail.txt") -Encoding utf8
    }
    $npmLogs = Join-Path $root 'npm-cache\_logs'
    if (Test-Path -LiteralPath $npmLogs) {
        foreach ($log in @(Get-ChildItem -LiteralPath $npmLogs -File)) {
            Get-Content -LiteralPath $log.FullName -Tail 200 | Set-Content -LiteralPath (Join-Path $evidence "npm-$($log.Name)") -Encoding utf8
        }
    }
    $bytes = (Get-ChildItem -LiteralPath $evidence -File -Recurse | Measure-Object Length -Sum).Sum
    if ($bytes -gt 26214400) { throw 'Diagnostic retention exceeds 25 MiB' }
    exit 0
}

if ($Phase -eq 'cleanup') {
    $stages = @()
    foreach ($specFile in @(Get-ChildItem -LiteralPath $root -Filter '*-spec.json' -File)) {
        $spec = Get-Content -LiteralPath $specFile.FullName -Raw | ConvertFrom-Json
        $receipt = Get-Content -LiteralPath $spec.receipt -Raw | ConvertFrom-Json
        if (!$receipt.complete -or $receipt.activeProcesses -ne 0) { throw "Incomplete process ownership evidence: $($specFile.Name)" }
        $stages += $specFile.BaseName
    }
    @{ complete = $true; scope = 'producer processes only'; reconciledStages = $stages } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'producer-cleanup.json') -Encoding utf8
    exit 0
}

if ($Phase -ne 'init') {
    $owner = Get-Content -LiteralPath (Join-Path $root 'owner.json') -Raw | ConvertFrom-Json
    if ($owner.sourceSha -ne $candidateSha -or $owner.architecture -ne $env:EXPECTED_ARCHITECTURE) { throw 'Product ownership mismatch' }
}
$seconds = switch ($Phase) {
    'init' { 60 }
    'binding' { 900 }
    default { 1780 }
}
if ($env:PASEO_WINDOWS_DEADLINE -notmatch '^\d+$' -or
    ([long]$env:PASEO_WINDOWS_DEADLINE - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -lt ($seconds + 120)) {
    throw 'Insufficient whole-job budget for this stage and cleanup'
}
$specFile = Join-Path $root "$Phase-spec.json"
if (Test-Path -LiteralPath $specFile) { throw "Do not repeat producer stage $Phase" }
$receiptFile = Join-Path $evidence "$Phase-job.json"
$startReceipt = Join-Path $root "$Phase-start.json"
$env:PASEO_WINDOWS_JOB_START = $startReceipt
$buildTelemetry = if ($Phase -in @('install-candidate', 'install-previous', 'binding', 'build-candidate', 'build-previous')) {
    Join-Path (Split-Path (Get-NativeCompiler)) 'VCTIP.EXE'
} else { $null }
@{
    executable = $node; arguments = @((Join-Path $PSScriptRoot 'windows-product-build.mjs'), $Phase)
    directory = $env:GITHUB_WORKSPACE; log = (Join-Path $root "logs\$Phase.log")
    receipt = $receiptFile; timeoutSeconds = $seconds; startReceipt = $startReceipt
    allowedBuildTelemetry = $buildTelemetry
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $specFile -Encoding utf8
& $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'windows-owned-job.ps1') -Specification $specFile
$status = $LASTEXITCODE
$receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
$telemetryCleaned = $buildTelemetry -and $receipt.buildSucceededWithTelemetryCleanup -and $receipt.allowedBuildTelemetry -eq $buildTelemetry
if ($status -ne 0 -or !$receipt.complete -or $receipt.activeProcesses -ne 0 -or $receipt.exitCode -ne 0 -or ($receipt.terminated -and !$telemetryCleaned) -or $receipt.timedOut) {
    throw "Owned producer stage failed: $Phase"
}
exit 0
