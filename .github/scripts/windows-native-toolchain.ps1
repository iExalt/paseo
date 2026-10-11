# Discovery only: callers enforce trusted hosted-run and native-architecture guards.
function Get-NativeCompiler {
    if (!$IsWindows -or $env:EXPECTED_ARCHITECTURE -notin @('arm64', 'x64')) { throw 'Native Windows architecture required' }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $visualStudio = (& $vswhere -latest -products '*' -property installationPath).Trim()
    if ($LASTEXITCODE -ne 0 -or !$visualStudio) { throw 'Visual Studio discovery failed' }
    $toolVersion = (Get-Content -LiteralPath (Join-Path $visualStudio 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    $hostArch = if ($env:EXPECTED_ARCHITECTURE -eq 'arm64') { 'Arm64' } else { 'x64' }
    $compiler = Join-Path $visualStudio "VC\Tools\MSVC\$toolVersion\bin\Host$hostArch\$($env:EXPECTED_ARCHITECTURE)\cl.exe"
    if (!(Test-Path -LiteralPath $compiler)) { throw 'Native compiler missing' }
    return $compiler
}
