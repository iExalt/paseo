param([Parameter(Mandatory = $true)][ValidateSet('setup', 'ownership', 'install', 'build', 'runtime', 'cleanup', 'diagnostics')][string]$Phase)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -ne 'iExalt/paseo' -or $env:GITHUB_REF -ne 'refs/heads/dev' -or $env:GITHUB_ACTOR -ne 'iExalt') {
    throw 'Trusted hosted Windows dev run required'
}
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') { throw 'Invalid run identity' }
$root = Join-Path $env:RUNNER_TEMP "paseo-windows-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
$evidence = Join-Path $root 'evidence'
$ownerFile = Join-Path $root 'owner.json'
$monitor = Join-Path $PSScriptRoot 'windows-owned-job.ps1'
$node = (Get-Command node.exe).Source
$pwsh = (Get-Process -Id $PID).Path
$installDirectory = Join-Path $root 'Installed App With Spaces'
$guid = '5c8e074b-0491-4c4b-a01e-806ad86b9b2f'
$productName = 'Paseo Windows Fixture'
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$productName.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Programs')) "$productName.lnk")
)

function Assert-NoFixtureProcess {
    if (@(Get-Process -Name $productName -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Unexpected fixture process outside the completed job' }
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
                        } }
                        finally { $key.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
}

function Write-Spec([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Seconds, [string]$NsisDirectory = '') {
    $specFile = Join-Path $root "$Name-spec.json"
    if (Test-Path -LiteralPath $specFile) { throw "Do not repeat stage $Name" }
    @{
        executable = $Executable; arguments = @($Arguments); directory = $env:GITHUB_WORKSPACE
        log = (Join-Path $root "logs\$Name.log"); receipt = (Join-Path $evidence "$Name-job.json")
        timeoutSeconds = $Seconds; nsisInstallDirectory = $NsisDirectory
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $specFile -Encoding utf8
    return $specFile
}

function Run-Owned([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Seconds, [bool]$ExpectedFailure = $false, [string]$NsisDirectory = '') {
    $specFile = Write-Spec $Name $Executable $Arguments $Seconds $NsisDirectory
    & $pwsh -NoProfile -File $monitor -Specification $specFile | Write-Host
    $status = $LASTEXITCODE
    $receipt = Get-Content -LiteralPath (Join-Path $evidence "$Name-job.json") -Raw | ConvertFrom-Json
    if (!$receipt.complete -or $receipt.activeProcesses -ne 0) { throw "Incomplete job cleanup: $Name" }
    if ($ExpectedFailure) {
        if ($status -eq 0 -or $receipt.exitCode -ne 7 -or !$receipt.terminated -or $receipt.timedOut) { throw 'Negative proof did not fail for the intended reason' }
    } elseif ($status -ne 0 -or $receipt.exitCode -ne 0 -or $receipt.terminated -or $receipt.timedOut) { throw "Owned stage failed: $Name" }
    return $receipt
}

if ($Phase -eq 'setup') {
    if (Test-Path -LiteralPath $root) { throw 'Refuse reused prerequisite root' }
    if ((git rev-parse HEAD).Trim() -ne $env:GITHUB_SHA -or (git status --porcelain)) { throw 'Exact clean checkout required' }
    if ((& $node -p 'process.version') -ne 'v26.11.0' -or (& $node -p 'process.arch') -ne $env:EXPECTED_ARCHITECTURE) { throw 'Native pinned Node required' }
    if ((npm --version) -ne '11.20.0') { throw 'Pinned npm required' }
    if (@(Read-Registrations).Count -ne 0) { throw 'Fixture registry identity is already occupied' }
    Assert-NoFixtureProcess
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Fixture shortcut identity is occupied' } }
    New-Item -ItemType Directory -Path $root, $evidence, (Join-Path $root 'logs'), (Join-Path $root 'npm-cache') | Out-Null
    $identity = @{
        sourceSha = $env:GITHUB_SHA; architecture = $env:EXPECTED_ARCHITECTURE
        node = '26.11.0'; npm = '11.20.0'; lockSha256 = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
        imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
        cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfLogicalProcessors)
        physicalMemoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        diskFreeBytes = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))).AvailableFreeSpace
    }
    $identity | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ownerFile -Encoding utf8
    Copy-Item -LiteralPath $ownerFile -Destination (Join-Path $evidence 'identity.json')
    exit 0
}
if (!(Test-Path -LiteralPath $ownerFile)) {
    if ($Phase -eq 'cleanup') { exit 0 }
    throw 'Owned prerequisite root missing'
}
$owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
if ($owner.sourceSha -ne $env:GITHUB_SHA -or $owner.architecture -ne $env:EXPECTED_ARCHITECTURE) { throw 'Prerequisite ownership mismatch' }

if ($Phase -eq 'ownership') {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-job.cs')
    $fixture = Join-Path $PSScriptRoot 'windows-process-fixture.cjs'
    $normal = Run-Owned 'normal' $node @($fixture, 'normal', 'unused', 'space value', 'quote"value', 'tail with space\', '') 20
    if ($normal.totalProcesses -lt 2) { throw 'Normal descendant was not accounted for' }
    $negative = Run-Owned 'negative' $node @($fixture, 'negative', (Join-Path $root 'negative-ready.json')) 20 $true
    if ($negative.totalProcesses -lt 2) { throw 'Detached descendant was not accounted for' }
    $ready = Join-Path $root 'death-ready.json'
    $specFile = Write-Spec 'death' $node @($fixture, 'alive', $ready) 60
    $monitorArguments = @('-NoProfile', '-File', $monitor, '-Specification', $specFile) | ForEach-Object { [PaseoOwnedJob]::Quote($_) }
    $monitorProcess = Start-Process -FilePath $pwsh -ArgumentList ($monitorArguments -join ' ') -PassThru
    $held = @()
    try {
        $null = $monitorProcess.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline -and !$monitorProcess.HasExited) { Start-Sleep -Milliseconds 50 }
        $identities = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
        foreach ($childId in @($identities.primary, $identities.detached)) {
            $process = Get-Process -Id $childId
            $null = $process.Handle # Hold each exact process object across monitor death/PID reuse.
            $held += $process
            if ([PaseoOwnedJob]::WaitForSingleObject($process.Handle, 0) -ne 258) { throw 'Death-proof child must first be alive' }
        }
        $monitorProcess.Kill()
        if (!$monitorProcess.WaitForExit(5000)) { throw 'Monitor did not exit' }
        foreach ($process in $held) {
            if ([PaseoOwnedJob]::WaitForSingleObject($process.Handle, 5000) -ne 0) { throw 'Kill-on-close left a fixture process alive' }
        }
        @{
            complete = $true; heldProcessCount = $held.Count; jobHandleShared = $false
            observedProcesses = @($held | ForEach-Object { @{ pid = $_.Id; exited = $true } })
            monitorPid = $monitorProcess.Id
        } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'monitor-death.json')
    } finally {
        if (!$monitorProcess.HasExited) { $monitorProcess.Kill(); $null = $monitorProcess.WaitForExit(5000) }
        foreach ($process in $held) { $process.Dispose() }
        $monitorProcess.Dispose()
    }
} elseif ($Phase -eq 'install') {
    $env:npm_config_cache = Join-Path $root 'npm-cache'
    $npmEntry = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $npmEntry)) { throw 'Bundled npm entry point missing' }
    $null = Run-Owned 'npm-install' $node @($npmEntry, 'ci', '--timing', '--foreground-scripts', '--no-audit', '--no-fund') 1780
    if ((Get-FileHash package-lock.json -Algorithm SHA256).Hash -ne $owner.lockSha256) { throw 'Locked install changed lockfile' }
} elseif ($Phase -eq 'build') {
    $null = Run-Owned 'package' $node @((Join-Path $PSScriptRoot 'windows-prerequisite.mjs'), 'build', $root) 280
} elseif ($Phase -eq 'runtime') {
    if ((Test-Path -LiteralPath $installDirectory) -or @(Read-Registrations).Count -ne 0) { throw 'Existing fixture installation' }
    foreach ($version in @('0.9.0', '1.0.0')) {
        $installer = Join-Path $root "packages\fixture-$version-$($env:EXPECTED_ARCHITECTURE).exe"
        $null = Run-Owned "install-$version" $installer @('/S', '/currentuser') 90 $false $installDirectory
        $registrations = @(Read-Registrations)
        $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
        if ($uninstallers.Count -ne 1) { throw 'Expected one owned uninstaller' }
        $expectedUninstall = '"' + $uninstallers[0].FullName + '" /currentuser'
        if (@($registrations | Where-Object hive -eq 'LocalMachine').Count -ne 0) { throw 'Installer escaped current-user registry scope' }
        foreach ($kind in @('install', 'uninstall')) {
            $entries = @($registrations | Where-Object kind -eq $kind)
            if ($entries.Count -eq 0) { throw "Missing $kind registration" }
            foreach ($entry in $entries) {
                if ($kind -eq 'install') {
                    if ([string]::IsNullOrEmpty($entry.location) -or $entry.location.TrimEnd('\') -ne $installDirectory.TrimEnd('\')) { throw 'Wrong installed location' }
                } else {
                    if ($entry.version -ne $version) { throw 'Wrong installed version' }
                    if ($entry.uninstall -ne $expectedUninstall -or $entry.quietUninstall -ne "$expectedUninstall /S") { throw 'Uninstall registration escaped owned installation' }
                }
            }
        }
        $registrations | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence "registration-$version.json")
        # Installer job reached active=0 before this explicit launch: no broker auto-launch is requested.
        Assert-NoFixtureProcess
        $null = Run-Owned "renderer-$version" $node @((Join-Path $PSScriptRoot 'windows-prerequisite.mjs'), 'ui', $root, $version) 60
    }
    $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
    if ($uninstallers.Count -ne 1) { throw 'Expected one owned uninstaller' }
    $null = Run-Owned 'uninstall' $uninstallers[0].FullName @('/S', '/currentuser') 60
    if ((Test-Path -LiteralPath $installDirectory) -or @(Read-Registrations).Count -ne 0) { throw 'Uninstall left installation or registration behind' }
    Assert-NoFixtureProcess
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Uninstall left a fixture shortcut' } }
    @{ complete = $true; installDirectoryAbsent = $true; registryAbsent = $true } | ConvertTo-Json | Set-Content (Join-Path $evidence 'uninstall.json')
} elseif ($Phase -eq 'cleanup') {
    # Recovery may remove only this fixture's exact installation through its own uninstaller.
    if (Test-Path -LiteralPath $installDirectory) {
        $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
        if ($uninstallers.Count -ne 1) { throw 'Cannot prove safe fixture uninstall recovery' }
        $null = Run-Owned 'cleanup-uninstall' $uninstallers[0].FullName @('/S', '/currentuser') 60
    }
    if ((Test-Path -LiteralPath $installDirectory) -or @(Read-Registrations).Count -ne 0) { throw 'Fixture cleanup incomplete' }
    Assert-NoFixtureProcess
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Cleanup left a fixture shortcut' } }
    # A spec precedes every monitor launch. Missing evidence fails closed even if
    # the monitor was interrupted before launching its primary process.
    $reconciled = @()
    foreach ($specFile in @(Get-ChildItem -LiteralPath $root -Filter '*-spec.json' -File)) {
        $spec = Get-Content -LiteralPath $specFile.FullName -Raw | ConvertFrom-Json
        if ($specFile.Name -eq 'death-spec.json') {
            $proof = Get-Content -LiteralPath (Join-Path $evidence 'monitor-death.json') -Raw | ConvertFrom-Json
            if (!$proof.complete -or $proof.heldProcessCount -ne 2 -or $proof.jobHandleShared -or
                @($proof.observedProcesses).Count -ne 2 -or @($proof.observedProcesses | Where-Object { !$_.exited }).Count -ne 0) {
                throw 'Incomplete monitor-death cleanup evidence'
            }
        } else {
            $proof = Get-Content -LiteralPath $spec.receipt -Raw | ConvertFrom-Json
            if (!$proof.complete -or $proof.activeProcesses -ne 0) { throw "Incomplete monitor cleanup evidence: $($specFile.Name)" }
        }
        $reconciled += $specFile.BaseName
    }
    @{ complete = $true; installed = $false; reconciledStages = $reconciled } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'cleanup.json')
} elseif ($Phase -eq 'diagnostics') {
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
}
# GitHub's pwsh wrapper propagates LASTEXITCODE. The intentional negative monitor
# leaves it nonzero even after its expected failure and cleanup were verified.
exit 0
