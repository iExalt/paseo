param([ValidateSet('apply', 'restore')][string]$Operation, [string]$Root)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -ne 'iExalt/paseo' -or $env:GITHUB_REF -ne 'refs/heads/dev' -or $env:GITHUB_ACTOR -ne 'iExalt') {
    throw 'Disposable trusted Windows runner required'
}
$expected = Join-Path $env:RUNNER_TEMP "paseo-windows-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
if ([IO.Path]::GetFullPath($Root) -ne [IO.Path]::GetFullPath($expected)) { throw 'Wrong policy receipt root' }
$receiptFile = Join-Path $Root 'evidence\telemetry-policy.json'
$keyPath = 'Software\Policies\Microsoft\VisualStudio\SQM'
# Microsoft documents OptIn DWORD=0 as the VSCEIP policy opt-out.
# https://learn.microsoft.com/visualstudio/ide/visual-studio-experience-improvement-program
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
    if ($Operation -eq 'apply') {
        if (Test-Path -LiteralPath $receiptFile) { throw 'Do not repeat policy mutation' }
        $key = $base.OpenSubKey($keyPath)
        $existed = $false
        $kind = $null
        $value = $null
        try {
            if ($null -ne $key -and $key.GetValueNames() -contains 'OptIn') {
                $existed = $true
                $kind = $key.GetValueKind('OptIn').ToString()
                $value = $key.GetValue('OptIn')
                if ($kind -ne 'DWord' -or $value -notin @(0, 1)) { throw 'Unexpected existing telemetry policy' }
            }
            $state = @{ sourceSha = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT
                hive = 'LocalMachine'; view = 'Registry64'; key = $keyPath; name = 'OptIn'
                valueExisted = $existed; kind = $kind; value = $value; restored = $false }
            # Persist recovery data before the mutation, including absent values.
            $state | ConvertTo-Json | Set-Content -LiteralPath $receiptFile -Encoding utf8
        } finally { if ($null -ne $key) { $key.Dispose() } }
        $key = $base.CreateSubKey($keyPath)
        try {
            $key.SetValue('OptIn', 0, [Microsoft.Win32.RegistryValueKind]::DWord)
            if ($key.GetValue('OptIn') -ne 0 -or $key.GetValueKind('OptIn').ToString() -ne 'DWord') { throw 'Policy readback failed' }
        } finally { $key.Dispose() }
    } else {
        if (!(Test-Path -LiteralPath $receiptFile)) { return }
        $state = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
        if ($state.sourceSha -ne $env:GITHUB_SHA -or $state.runId -ne $env:GITHUB_RUN_ID -or $state.attempt -ne $env:GITHUB_RUN_ATTEMPT -or
            $state.hive -ne 'LocalMachine' -or $state.view -ne 'Registry64' -or $state.key -ne $keyPath -or $state.name -ne 'OptIn') { throw 'Policy recovery identity mismatch' }
        $key = $base.OpenSubKey($keyPath, $true)
        try {
            if ($state.valueExisted) {
                if ($null -eq $key -or $state.kind -ne 'DWord' -or $state.value -notin @(0, 1)) { throw 'Unsupported policy recovery' }
                $key.SetValue('OptIn', [int]$state.value, [Microsoft.Win32.RegistryValueKind]::DWord)
                if ($key.GetValue('OptIn') -ne $state.value -or $key.GetValueKind('OptIn').ToString() -ne $state.kind) { throw 'Policy restoration failed' }
            } elseif ($null -ne $key) {
                $key.DeleteValue('OptIn', $false)
                if ($key.GetValueNames() -contains 'OptIn') { throw 'Created policy value remains' }
            }
        } finally { if ($null -ne $key) { $key.Dispose() } }
        $state.restored = $true
        $state | ConvertTo-Json | Set-Content -LiteralPath $receiptFile -Encoding utf8
    }
} finally { $base.Dispose() }
