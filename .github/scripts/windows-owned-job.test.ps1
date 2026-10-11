$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('PaseoOwnedJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-job.cs') }
function New-Receipt {
    $receipt = [PaseoOwnedJob+Receipt]::new()
    $receipt.complete = $true
    $receipt.terminated = $true
    $receipt.exitCode = 0
    $receipt.allowedBuildTelemetry = 'C:\toolchain\VCTIP.EXE'
    $receipt.telemetryTotalBefore = 2
    $receipt.telemetryTotalVerified = 2
    $receipt.totalProcesses = 2
    $receipt.telemetryActiveBefore = 1
    $receipt.telemetryActiveVerified = 1
    $member = [PaseoOwnedJob+MemberDiagnostic]::new()
    $member.pid = 42
    $member.image = $receipt.allowedBuildTelemetry
    $member.startedUtc = '2026-10-11T00:00:00Z'
    $member.membershipVerified = $true
    $receipt.remainingProcesses = @($member)
    return $receipt
}
if (![PaseoOwnedJob]::IsBuildTelemetryCleanup((New-Receipt))) { throw 'Exact telemetry survivor rejected' }
$cases = @{
    unknown = { param($r) $r.remainingProcesses[0].image = 'C:\toolchain\cl.exe' }
    nonzero = { param($r) $r.exitCode = 7 }
    timeout = { param($r) $r.timedOut = $true }
    defaultStrict = { param($r) $r.allowedBuildTelemetry = $null }
    unverified = { param($r) $r.remainingProcesses[0].membershipVerified = $false }
    unreadable = { param($r) $r.remainingProcesses[0].error = 'access denied' }
    truncated = { param($r) $r.processDiagnosticError = 'incomplete list' }
    countMismatch = { param($r) $r.telemetryActiveBefore = 2 }
    exitedDuringSnapshot = { param($r) $r.telemetryActiveVerified = 0 }
    bornDuringSnapshot = { param($r) $r.telemetryTotalVerified = 3 }
    bornDuringTermination = { param($r) $r.totalProcesses = 3 }
    incompleteCleanup = { param($r) $r.complete = $false }
    survivor = { param($r) $r.activeProcesses = 1 }
}
foreach ($case in $cases.GetEnumerator()) {
    $receipt = New-Receipt
    & $case.Value $receipt
    if ([PaseoOwnedJob]::IsBuildTelemetryCleanup($receipt)) { throw "Accepted invalid classification: $($case.Key)" }
}
Write-Host 'Build telemetry classifier: positive and distinct rejection cases passed'
