param([Parameter(Mandatory = $true)][ValidateSet('prepare', 'models', 'runtime', 'cleanup')][string]$Phase)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -ne 'iExalt/paseo' -or $env:GITHUB_REF -ne 'refs/heads/dev' -or $env:GITHUB_ACTOR -ne 'iExalt') {
    throw 'Trusted hosted Windows dev run required'
}
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') { throw 'Invalid run identity' }
$root = Join-Path $env:RUNNER_TEMP "paseo-windows-products-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
if (!(Test-Path -LiteralPath (Join-Path $root 'owner.json'))) {
    if ($Phase -eq 'cleanup') { exit 0 }
    throw 'Product owner missing'
}
$owner = Get-Content -LiteralPath (Join-Path $root 'owner.json') -Raw | ConvertFrom-Json
if ($owner.sourceSha -ne $env:GITHUB_SHA -or $owner.architecture -ne $env:EXPECTED_ARCHITECTURE) { throw 'Product ownership mismatch' }
$evidence = Join-Path $root 'evidence'
$installDirectory = Join-Path $root 'Installed App With Spaces'
$guid = 'ca8eee31-e786-591a-8405-a3710823b93a' # UUIDv5 of sh.paseo.desktop in electron-builder's namespace.
$node = (Get-Command node.exe).Source
$pwsh = (Get-Process -Id $PID).Path
$shortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Paseo.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Paseo.lnk'))
$marker = Join-Path $root 'runtime-owner.json'

function Assert-NoPaseoProcess {
    if (@(Get-Process -ErrorAction Stop | Where-Object ProcessName -eq 'Paseo').Count -ne 0) {
        throw 'Unexpected Paseo process outside completed Jobs; do not terminate it'
    }
}

function Read-Registrations {
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                foreach ($kind in @('install', 'uninstall')) {
                    $subkey = if ($kind -eq 'install') { "Software\$guid" } else { "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" }
                    $key = $base.OpenSubKey($subkey)
                    if ($null -ne $key) {
                        try { [pscustomobject]@{
                            hive = "$hive"; view = "$view"; kind = $kind
                            location = $key.GetValue('InstallLocation'); version = $key.GetValue('DisplayVersion')
                            uninstall = $key.GetValue('UninstallString'); quietUninstall = $key.GetValue('QuietUninstallString')
                        } } finally { $key.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
}
function Run-Owned([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Seconds, [string]$NsisDirectory = '') {
    if ($Phase -ne 'cleanup' -and ($env:PASEO_WINDOWS_DEADLINE -notmatch '^\d+$' -or
        ([long]$env:PASEO_WINDOWS_DEADLINE - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -lt ($Seconds + 120))) {
        throw 'Insufficient whole-job budget for this operation and cleanup'
    }
    $specFile = Join-Path $root "$Name-spec.json"
    if (Test-Path -LiteralPath $specFile) { throw "Do not repeat stage $Name" }
    $env:PASEO_WINDOWS_JOB_START = Join-Path $root "$Name-start.json"
    @{
        executable = $Executable; arguments = @($Arguments); directory = $env:GITHUB_WORKSPACE
        log = (Join-Path $root "logs\$Name.log"); receipt = (Join-Path $evidence "$Name-job.json")
        timeoutSeconds = $Seconds; nsisInstallDirectory = $NsisDirectory
        startReceipt = $env:PASEO_WINDOWS_JOB_START
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $specFile -Encoding utf8
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'windows-owned-job.ps1') -Specification $specFile | Write-Host
    $status = $LASTEXITCODE
    $receipt = Get-Content -LiteralPath (Join-Path $evidence "$Name-job.json") -Raw | ConvertFrom-Json
    if ($status -ne 0 -or !$receipt.complete -or $receipt.activeProcesses -ne 0 -or $receipt.exitCode -ne 0 -or $receipt.terminated -or $receipt.timedOut) { throw "Strict product stage failed: $Name" }
}
function Run-Node([string]$Name, [int]$Seconds) {
    Run-Owned $Name $node @((Join-Path $PSScriptRoot 'windows-product-runtime.mjs'), $Name) $Seconds
}
function Assert-EmptyJobs {
    foreach ($specFile in @(Get-ChildItem -LiteralPath $root -Filter '*-spec.json' -File)) {
        $spec = Get-Content -LiteralPath $specFile.FullName -Raw | ConvertFrom-Json
        $receipt = Get-Content -LiteralPath $spec.receipt -Raw | ConvertFrom-Json
        if (!$receipt.complete -or $receipt.activeProcesses -ne 0) { throw "Incomplete ownership: $($specFile.Name)" }
    }
}
function Uninstall-Owned([string]$Name) {
    Assert-EmptyJobs
    Assert-NoPaseoProcess
    if (Test-Path -LiteralPath $installDirectory) {
        $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
        if ($uninstallers.Count -ne 1) { throw 'Expected exactly one owned uninstaller' }
        Run-Owned $Name $uninstallers[0].FullName @('/S', '/currentuser') 60
    }
    if ((Test-Path -LiteralPath $installDirectory) -or @(Read-Registrations).Count -ne 0) { throw 'Installation cleanup incomplete' }
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Shortcut remains' } }
    Assert-NoPaseoProcess
}
if ($Phase -eq 'prepare') {
    Assert-NoPaseoProcess
    if ((Test-Path -LiteralPath $marker) -or (Test-Path -LiteralPath $installDirectory) -or @(Read-Registrations).Count -ne 0) { throw 'Refuse pre-existing product installation' }
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Pre-existing shortcut' } }
    @{ sourceSha = $env:GITHUB_SHA; installDirectory = $installDirectory } | ConvertTo-Json | Set-Content -LiteralPath $marker
} elseif ($Phase -eq 'models') {
    Run-Node 'models' 580
} elseif ($Phase -eq 'runtime') {
    if (!(Test-Path -LiteralPath $marker)) { throw 'Runtime baseline missing' }
    foreach ($stage in @('previous', 'candidate')) {
        Assert-EmptyJobs
        $identity = Get-Content -LiteralPath (Join-Path $root "$stage.json") -Raw | ConvertFrom-Json
        $installer = Join-Path $root "packages\$stage\$stage-$($env:EXPECTED_ARCHITECTURE).exe"
        if ($identity.installer.filename -ne $installer -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $identity.installer.sha256) { throw 'Installer identity mismatch' }
        Run-Owned "nsis-$stage" $installer @('/S', '/currentuser') 90 $installDirectory
        Assert-NoPaseoProcess
        $registrations = @(Read-Registrations)
        $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
        if ($uninstallers.Count -ne 1) { throw 'Expected one uninstaller' }
        $expectedUninstall = '"' + $uninstallers[0].FullName + '" /currentuser'
        if (@($registrations | Where-Object hive -eq 'LocalMachine').Count -ne 0) { throw 'Installer escaped current-user scope' }
        foreach ($kind in @('install', 'uninstall')) {
            $entries = @($registrations | Where-Object kind -eq $kind)
            if ($entries.Count -eq 0) { throw "Missing $kind registry" }
            foreach ($entry in $entries) {
                if ($kind -eq 'install') {
                    if ($entry.location -ne $installDirectory) { throw 'Wrong installed location' }
                } elseif ($entry.version -ne $identity.version -or $entry.uninstall -ne $expectedUninstall -or $entry.quietUninstall -ne "$expectedUninstall /S") { throw 'Wrong uninstall registration' }
            }
        }
        $registrations | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence "registration-$stage.json")
        Run-Node "inspect-$stage" 30
        Assert-NoPaseoProcess
        Run-Node "runtime-$stage" 180
    }
    Run-Node 'speech' 280
    Uninstall-Owned 'uninstall'
    @{ complete = $true; directoryAbsent = $true; registryAbsent = $true } | ConvertTo-Json | Set-Content (Join-Path $evidence 'uninstall.json')
} elseif ($Phase -eq 'cleanup') {
    Assert-EmptyJobs
    if (Test-Path -LiteralPath $marker) {
        $runtimeOwner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ($runtimeOwner.sourceSha -ne $env:GITHUB_SHA -or $runtimeOwner.installDirectory -ne $installDirectory) { throw 'Runtime ownership mismatch' }
        Uninstall-Owned 'recovery-uninstall'
        Assert-EmptyJobs
        Remove-Item -LiteralPath (Join-Path $root 'state') -Recurse -Force
        if (Test-Path -LiteralPath (Join-Path $root 'state')) { throw 'Owned profile state remains' }
    }
    @{ complete = $true; installed = $false; stateRemoved = (Test-Path -LiteralPath $marker) } | ConvertTo-Json | Set-Content (Join-Path $evidence 'runtime-cleanup.json')
}
exit 0
