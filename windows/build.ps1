<#
.SYNOPSIS
    Build reproductible de DojoWallpaper (WinForms, .NET Framework 4.8, WebView2).

.DESCRIPTION
    1. Compile la Release dans build\ (intermediaire, ignore par git).
    2. Avec -Test : compile et lance les tests unitaires (tests\DojoWallpaper.Tests).
    3. Recopie le binaire et ses dependances dans bin\ (versionne, sans PDB).
    4. Affiche la taille totale de bin\.

    Compatible Windows PowerShell 5.1 et PowerShell 7.

.EXAMPLE
    pwsh -File build.ps1 -Test
    powershell.exe -File build.ps1 -Test
#>
[CmdletBinding()]
param(
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

$root     = $PSScriptRoot
$appProj  = Join-Path $root 'DojoWallpaper.csproj'
$testDir  = Join-Path $root 'tests\DojoWallpaper.Tests'
$testProj = Join-Path $testDir 'DojoWallpaper.Tests.csproj'
$buildOut = Join-Path $root 'build\Release\net48'
$testExe  = Join-Path $testDir 'build\Release\net48\DojoWallpaper.Tests.exe'
$binDir   = Join-Path $root 'bin'

# Fichiers copies dans bin\ (chemins relatifs au dossier de sortie de build).
$binFiles = @(
    'DojoWallpaper.exe',
    'DojoWallpaper.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'runtimes\win-x64\native\WebView2Loader.dll',
    'runtimes\win-x86\native\WebView2Loader.dll'
)

function Find-DotNetSdk {
    # Ordre : PATH, DOTNET_ROOT, Program Files, install utilisateur (dotnet-install.ps1).
    $candidates = New-Object System.Collections.Generic.List[string]
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd) { $candidates.Add($cmd.Source) }
    if ($env:DOTNET_ROOT) { $candidates.Add((Join-Path $env:DOTNET_ROOT 'dotnet.exe')) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'dotnet\dotnet.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe')) }

    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        # Un runtime seul ne suffit pas : il faut un SDK pour compiler.
        $sdks = @(& $candidate --list-sdks)
        if ($LASTEXITCODE -eq 0 -and $sdks.Count -gt 0) { return $candidate }
    }
    return $null
}

function Invoke-DotNet {
    param([string[]]$Arguments)
    & $script:dotnet @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet $($Arguments -join ' ') a echoue (code $LASTEXITCODE)"
    }
}

try {
    $script:dotnet = Find-DotNetSdk
    if (-not $script:dotnet) {
        throw 'SDK .NET introuvable. Installer : winget install --id Microsoft.DotNet.SDK.8 -e  (ou dotnet-install.ps1 -Channel 8.0)'
    }
    $sdkVersion = (& $script:dotnet --version).Trim()
    Write-Host "dotnet : $($script:dotnet)"
    Write-Host "SDK    : $sdkVersion"

    Write-Host '== Build application (Release) =='
    Invoke-DotNet -Arguments @('build', $appProj, '-c', 'Release', '--nologo', '-v:minimal')

    if ($Test) {
        Write-Host '== Build tests (Release) =='
        Invoke-DotNet -Arguments @('build', $testProj, '-c', 'Release', '--nologo', '-v:minimal')

        Write-Host '== Tests =='
        & $testExe
        if ($LASTEXITCODE -ne 0) { throw "Tests en echec (code $LASTEXITCODE)" }
    }

    Write-Host '== Copie dans bin\ =='
    if (Test-Path -LiteralPath $binDir) {
        try {
            Remove-Item -LiteralPath $binDir -Recurse -Force
        }
        catch {
            throw "Impossible de vider bin\ (fichier verrouille, DojoWallpaper est-il lance ?) : $($_.Exception.Message)"
        }
    }
    New-Item -ItemType Directory -Path $binDir | Out-Null

    foreach ($rel in $binFiles) {
        $src = Join-Path $buildOut $rel
        if (-not (Test-Path -LiteralPath $src)) { throw "Fichier de build manquant : $src" }
        $dst = Join-Path $binDir $rel
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dst
        Write-Host "  $rel"
    }

    $files = @(Get-ChildItem -LiteralPath $binDir -Recurse -File)
    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    Write-Host ('bin\ : {0:N2} Mo ({1} fichiers)' -f ($totalBytes / 1MB), $files.Count)
    if ($totalBytes -gt 5MB) { Write-Warning 'bin\ depasse 5 Mo : a reconsiderer avant de versionner.' }

    Write-Host 'OK'
    exit 0
}
catch {
    [Console]::Error.WriteLine("ERREUR : " + $_.Exception.Message)
    exit 1
}
