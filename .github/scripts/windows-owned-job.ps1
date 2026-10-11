param([Parameter(Mandatory = $true)][string]$Specification)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-job.cs')
$spec = Get-Content -LiteralPath $Specification -Raw | ConvertFrom-Json
$installDirectory = if ($spec.PSObject.Properties.Name -contains 'nsisInstallDirectory') { $spec.nsisInstallDirectory } else { $null }
$receipt = [PaseoOwnedJob]::Run($spec.executable, [string[]]$spec.arguments, $spec.directory, $spec.log, $spec.timeoutSeconds, $installDirectory)
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $spec.receipt -Encoding utf8
Get-Content -LiteralPath $spec.log -Tail 100 -ErrorAction SilentlyContinue
if (!$receipt.complete -or $receipt.timedOut -or $receipt.terminated -or $receipt.exitCode -ne 0) { exit 1 }
