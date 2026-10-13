param([Parameter(Mandatory = $true)][ValidateSet('setup', 'check', 'cleanup')][string]$Phase)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -ne 'iExalt/paseo' -or $env:GITHUB_REF -ne 'refs/heads/dev' -or
    $env:EXPECTED_ARCHITECTURE -notin @('arm64', 'x64') -or
    $env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') { throw 'Trusted native Windows run required' }
& node (Join-Path $PSScriptRoot 'native-candidate-authority.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Native actor or coordinator mismatch' }
$sourceSha = if ($env:PASEO_CANDIDATE_SHA) { $env:PASEO_CANDIDATE_SHA } else { $env:GITHUB_SHA }
if ($sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Exact source required' }
$controller = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$productRoot = Join-Path $env:RUNNER_TEMP "paseo-windows-products-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
$evidence = Join-Path $productRoot 'evidence\storage-cleanup.json'
if ($env:EXPECTED_ARCHITECTURE -eq 'x64') {
    if ($Phase -eq 'cleanup' -and (Test-Path -LiteralPath (Split-Path $evidence))) {
        @{ complete = $true; applicable = $false; architecture = 'x64' } | ConvertTo-Json | Set-Content -LiteralPath $evidence
    }
    exit 0
}
if ($controller -notmatch '^C:\\' -or $env:RUNNER_TEMP -notmatch '^C:\\') { throw 'Controller and evidence must remain on C' }
$root = Join-Path $env:RUNNER_TEMP "paseo-windows-storage-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
$ownerFile = Join-Path $root 'owner.json'
$vhdPath = Join-Path $root 'sources.vhdx'
$size = 64GB

function Read-OwnedStorage {
    if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ((Get-Item -LiteralPath $ownerFile).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected ownership record' }
    $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if ($owner.schema -ne 1 -or $owner.runId -ne $env:GITHUB_RUN_ID -or $owner.attempt -ne $env:GITHUB_RUN_ATTEMPT -or
        $owner.architecture -ne 'arm64' -or $owner.sourceSha -ne $sourceSha -or $owner.controller -ne $controller -or
        $owner.vhdPath -ne $vhdPath) { throw 'Storage ownership mismatch' }
    if ($owner.volumeRoot) {
        if ($owner.volumeRoot -notmatch '^[D-Z]:\\$' -or $owner.candidate -ne (Join-Path $owner.volumeRoot 'paseo-candidate') -or
            $owner.previous -ne (Join-Path $owner.volumeRoot 'paseo-previous')) { throw 'Unexpected owned source paths' }
    }
    return $owner
}
function Get-OwnedImage {
    $owner = Read-OwnedStorage
    if ((Get-Item -LiteralPath $vhdPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected image' }
    $image = Get-VHD -Path $vhdPath
    if ($image.Path -ne $vhdPath -or $image.Size -ne $size -or $image.VhdFormat -ne 'VHDX' -or $image.VhdType -ne 'Dynamic' -or
        ($owner.diskIdentifier -and "$($image.DiskIdentifier)" -ne $owner.diskIdentifier)) { throw 'Owned image identity mismatch' }
    return $image
}
function Get-OwnedDisk {
    $image = Get-OwnedImage
    if (!$image.Attached) { throw 'Owned image not attached' }
    $disk = Get-Disk -Number $image.DiskNumber
    if ($disk.IsBoot -or $disk.IsSystem -or $disk.BusType -notin @('File Backed Virtual', 'FileBackedVirtual', 'Virtual')) { throw 'Refuse system or foreign disk' }
    return $disk
}
function Assert-OwnedVolume {
    $owner = Read-OwnedStorage
    $disk = Get-OwnedDisk
    if (!$owner.volumeRoot) { throw 'Owned volume path missing' }
    $partition = Get-Partition -DriveLetter $owner.volumeRoot.Substring(0, 1)
    if ($partition.DiskNumber -ne $disk.Number -or (Get-Volume -DriveLetter $partition.DriveLetter).FileSystem -ne 'ReFS') { throw 'Volume no longer belongs to owned ReFS disk' }
}
function Assert-UntrustedVolume {
    $owner = Read-OwnedStorage
    if (!$owner.ready) { throw 'Storage is not ready' }
    Assert-OwnedVolume
    $trust = (fsutil devdrv query $owner.volumeRoot | Out-String)
    if ($LASTEXITCODE -ne 0 -or $trust -notmatch '(?i)\buntrusted\b|\bnot\s+(?:a\s+)?trusted\b') { throw 'Explicit untrusted status required' }
    $filters = (fltmc instances -v $owner.volumeRoot.TrimEnd('\') | Out-String)
    if ($LASTEXITCODE -ne 0 -or $filters -notmatch '\bWdFilter\b') { throw 'Antivirus filter attachment not verified' }
}
function Invoke-SourceGit([string[]]$Arguments) {
    $result = & git -C $controller @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $Arguments" }
    return ($result | Out-String).Trim()
}
function Test-WorktreeRegistration([string]$Listing, [string]$Target) {
    return ($Listing -split '\r?\n') -contains "worktree $($Target.Replace('\', '/'))"
}

if ($Phase -eq 'cleanup') {
    if (!(Test-Path -LiteralPath $root)) { exit 0 }
    $owner = Read-OwnedStorage
    $failure = $null
    $worktreesRemoved = $false
    try {
        if (Test-Path -LiteralPath $productRoot) {
            foreach ($specFile in @(Get-ChildItem -LiteralPath $productRoot -Filter '*-spec.json' -File)) {
                $spec = Get-Content -LiteralPath $specFile.FullName -Raw | ConvertFrom-Json
                $receipt = Get-Content -LiteralPath $spec.receipt -Raw | ConvertFrom-Json
                if (!$receipt.complete -or $receipt.activeProcesses -ne 0) { throw 'Cannot prove zero owned processes' }
            }
        }
        if ($owner.volumeRoot) {
            $null = Get-OwnedDisk
            foreach ($target in @($owner.candidate, $owner.previous)) {
                Assert-OwnedVolume
                if (Test-WorktreeRegistration (Invoke-SourceGit @('worktree', 'list', '--porcelain')) $target) {
                    Assert-OwnedVolume
                    $null = Invoke-SourceGit @('-c', 'core.longpaths=true', 'worktree', 'remove', '--force', $target)
                }
                if ((Test-Path -LiteralPath $target) -or (Test-WorktreeRegistration (Invoke-SourceGit @('worktree', 'list', '--porcelain')) $target)) { throw 'Owned source worktree remains' }
            }
        }
        $worktreesRemoved = $true
    } catch { $failure = $_ }
    # Independently release the exact owned image even when process/worktree
    # reconciliation fails; never turn that failure into successful evidence.
    try {
        if (Test-Path -LiteralPath $vhdPath) {
            $image = Get-OwnedImage
            if ($image.Attached) {
                $null = Get-OwnedDisk
                Dismount-VHD -Path $vhdPath
            }
            if ((Get-OwnedImage).Attached) { throw 'Owned VHD remains attached' }
            Remove-Item -LiteralPath $vhdPath -Force
        }
        if (Test-Path -LiteralPath $vhdPath) { throw 'Owned VHD remains' }
    } catch { if (!$failure) { $failure = $_ } }
    $receipt = @{ complete = (!$failure -and $worktreesRemoved); applicable = $true; architecture = 'arm64'; worktreesRemoved = $worktreesRemoved; imageRemoved = !(Test-Path -LiteralPath $vhdPath); sourceSha = $sourceSha; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT }
    $receipt | ConvertTo-Json -Compress | Write-Output
    if (Test-Path -LiteralPath (Split-Path $evidence)) { $receipt | ConvertTo-Json | Set-Content -LiteralPath $evidence }
    if ($failure) { throw $failure }
    exit 0
}
if ($Phase -eq 'check') { Assert-UntrustedVolume; exit 0 }

if (Test-Path -LiteralPath $root) { throw 'Refuse reused storage identity' }
if ((Invoke-SourceGit @('rev-parse', 'HEAD')) -ne $sourceSha -or (Invoke-SourceGit @('status', '--porcelain'))) { throw 'Exact clean source required' }
if ((Get-PSDrive C).Free -lt 70GB) { throw 'Insufficient free space for isolated storage' }
$null = New-Item -ItemType Directory -Path $root
$owner = @{ schema = 1; ready = $false; sourceSha = $sourceSha; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; architecture = 'arm64'; controller = $controller; vhdPath = $vhdPath; diskIdentifier = $null; volumeRoot = $null; candidate = $null; previous = $null }
$owner | ConvertTo-Json | Set-Content -LiteralPath $ownerFile
$image = New-VHD -Path $vhdPath -SizeBytes $size -Dynamic
$owner.diskIdentifier = "$($image.DiskIdentifier)"
$owner | ConvertTo-Json | Set-Content -LiteralPath $ownerFile
$null = Get-OwnedImage
Mount-VHD -Path $vhdPath
$disk = Get-OwnedDisk
if ($disk.PartitionStyle -ne 'RAW') { throw 'New disk must be empty' }
Initialize-Disk -Number $disk.Number -PartitionStyle GPT
$disk = Get-OwnedDisk
$partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
$disk = Get-OwnedDisk
if ($partition.DiskNumber -ne $disk.Number) { throw 'Partition ownership changed' }
$partition = Get-Partition -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber
Format-Volume -Partition $partition -DevDrive -NewFileSystemLabel 'PaseoBuild' -Force -Confirm:$false | Out-Null
$disk = Get-OwnedDisk
$partition = Get-Partition -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber
$owner.volumeRoot = "$($partition.DriveLetter):\"
if ($owner.volumeRoot -notmatch '^[D-Z]:\\$') { throw 'Unexpected volume letter' }
$owner.candidate = Join-Path $owner.volumeRoot 'paseo-candidate'
$owner.previous = Join-Path $owner.volumeRoot 'paseo-previous'
$owner | ConvertTo-Json | Set-Content -LiteralPath $ownerFile
# The new volume is empty until its default trust is removed and freshly checked.
fsutil devdrv untrust /f $owner.volumeRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not untrust empty volume' }
$owner.ready = $true
$owner | ConvertTo-Json | Set-Content -LiteralPath $ownerFile
Assert-UntrustedVolume
@{ storageReady = $true; fileSystem = 'ReFS'; trust = 'untrusted'; sourceSha = $sourceSha; volumeRoot = $owner.volumeRoot } | ConvertTo-Json -Compress | Write-Output
