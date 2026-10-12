param([Parameter(Mandatory = $true)][string]$Specification)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-job.cs')
$spec = Get-Content -LiteralPath $Specification -Raw | ConvertFrom-Json
$installDirectory = if ($spec.PSObject.Properties.Name -contains 'nsisInstallDirectory') { $spec.nsisInstallDirectory } else { $null }
$startReceipt = if ($spec.PSObject.Properties.Name -contains 'startReceipt') { $spec.startReceipt } else { $null }
$startIdentity = if ($startReceipt) {
    @{
        sourceSha = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT
        specification = [IO.Path]::GetFullPath($Specification)
        specificationSha256 = (Get-FileHash -LiteralPath $Specification -Algorithm SHA256).Hash.ToLowerInvariant()
    } | ConvertTo-Json -Compress
} else { $null }
$telemetry = if ($spec.PSObject.Properties.Name -contains 'allowedBuildTelemetry') { $spec.allowedBuildTelemetry } else { $null }
$receipt = [PaseoOwnedJob]::Run($spec.executable, [string[]]$spec.arguments, $spec.directory, $spec.log, $spec.timeoutSeconds, $installDirectory, $startReceipt, $startIdentity, $telemetry, $spec.receipt)
Get-Content -LiteralPath $spec.log -Tail 100 -ErrorAction SilentlyContinue
if (!$receipt.complete -or $receipt.cancelled -or $receipt.timedOut -or ($receipt.terminated -and !$receipt.buildSucceededWithTelemetryCleanup) -or $receipt.exitCode -ne 0) { exit 1 }
